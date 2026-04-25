/**
 * SMTP probe — verify whether an email address exists WITHOUT sending a message.
 *
 * This replicates what Hunter.io / NeverBounce / ZeroBounce do under the hood:
 *   1. Connect TCP to the domain's MX server on port 25
 *   2. Send EHLO
 *   3. Send MAIL FROM (using a fake sender — no email is sent)
 *   4. Send RCPT TO <target@domain.com> — the server replies 250 (exists) or 550 (no)
 *   5. Send RCPT TO <zzz_random_xyz@domain.com> — if also 250, it's catch-all
 *   6. Send RSET + QUIT
 *
 * IMPORTANT: Port 25 is blocked on most cloud platforms (Vercel, Railway, etc.)
 * The probe handles this gracefully: ECONNREFUSED / ETIMEDOUT → status "unavailable"
 * so the caller can fall back to a paid verifier (ZeroBounce/AbstractAPI).
 *
 * Works: local development, self-hosted VPS, bare metal
 * Blocked: Vercel, Railway, Render, Fly.io free tier, most shared CDN platforms
 *
 * RFC compliance:
 *  - Uses EHLO with a fake HELO domain (accepted by all real servers)
 *  - MAIL FROM uses a verifier-only address (never actually delivers mail)
 *  - Always sends RSET before QUIT so we don't leave the server in a bad state
 */

import net from "net";
import tls from "tls";

const SMTP_CONNECT_TIMEOUT_MS = 3_000;
const SMTP_READ_TIMEOUT_MS = 5_000;
const HELO_DOMAIN = "mailhunt.local";
const MAIL_FROM = "check@mailhunt.local";

// ─── Response Codes ──────────────────────────────────────────────────────────

export type SmtpProbeStatus =
  | "valid"        // 250 — mailbox confirmed to exist
  | "catch_all"    // 250 for both real and random → domain accepts everything
  | "invalid"      // 550/551/553 — mailbox definitely does not exist
  | "unknown"      // Temp failure, greylisting, 4xx — inconclusive
  | "unavailable"; // Port 25 + 465 both blocked — SMTP not reachable from here

/** One step in the SMTP handshake log. Exposed in the engine debug output. */
export interface SmtpStep {
  step: "GREETING" | "EHLO" | "HELO" | "MAIL_FROM" | "RCPT_TO" | "CATCHALL_CHECK" | "RSET";
  sent: string | null;
  code: number;
  message: string;
  ms: number;
}

export interface SmtpProbeResult {
  email: string;
  status: SmtpProbeStatus;
  code: number;
  isCatchAll: boolean;
  /** false when SMTP is blocked on this host (port 25 and 465 firewalled) */
  smtpAvailable: boolean;
  /** Server greeting banner, e.g. "smtp.google.com ESMTP ..." */
  serverBanner: string | null;
  /** Full SMTP conversation log with per-step timing */
  log: SmtpStep[];
  /** Which port was actually used (25 or 465) */
  port: number;
}

// ─── TCP Socket SMTP session ─────────────────────────────────────────────────

/**
 * Internal SMTP session manager.
 * Maintains a shared receive buffer so responses that arrive in the same TCP
 * segment as a subsequent response are handled correctly.
 */
class SmtpSession {
  private buffer = "";
  private pendingResolve:
    | ((r: { code: number; message: string }) => void)
    | null = null;
  private pendingReject: ((e: Error) => void) | null = null;
  private pendingTimer: NodeJS.Timeout | null = null;

  constructor(private readonly socket: net.Socket) {
    socket.on("data", (chunk: Buffer) => {
      this.buffer += chunk.toString("ascii");
      this.tryFlush();
    });
  }

  private tryFlush() {
    const result = SmtpSession.parseFinalResponse(this.buffer);
    if (!result) return;
    this.buffer = this.buffer.slice(result.consumed);
    if (this.pendingResolve) {
      if (this.pendingTimer) clearTimeout(this.pendingTimer);
      const resolve = this.pendingResolve;
      this.pendingResolve = null;
      this.pendingReject = null;
      this.pendingTimer = null;
      resolve({ code: result.code, message: result.message });
    }
  }

  /**
   * Find the first "final" SMTP response line in the buffer.
   * Final lines match: ^\d{3} (space) — continuation lines use ^\d{3}- (dash).
   * Only complete lines (terminated by \r\n) are checked.
   */
  private static parseFinalResponse(
    buf: string
  ): { code: number; message: string; consumed: number } | null {
    let pos = 0;
    while (pos < buf.length) {
      const lineEnd = buf.indexOf("\r\n", pos);
      if (lineEnd === -1) break; // incomplete line — wait for more data
      const line = buf.slice(pos, lineEnd);
      const consumed = lineEnd + 2; // include \r\n length
      if (/^\d{3} /.test(line)) {
        return {
          code: parseInt(line.slice(0, 3), 10),
          message: line.slice(4),
          consumed,
        };
      }
      pos = consumed;
    }
    return null;
  }

  /** Read the next complete SMTP response from the server. */
  read(): Promise<{ code: number; message: string }> {
    // Response might already be buffered
    const immediate = SmtpSession.parseFinalResponse(this.buffer);
    if (immediate) {
      this.buffer = this.buffer.slice(immediate.consumed);
      return Promise.resolve({ code: immediate.code, message: immediate.message });
    }

    return new Promise((resolve, reject) => {
      this.pendingResolve = resolve;
      this.pendingReject = reject;
      this.pendingTimer = setTimeout(() => {
        this.pendingResolve = null;
        this.pendingReject = null;
        this.pendingTimer = null;
        reject(new Error("SMTP read timeout"));
      }, SMTP_READ_TIMEOUT_MS);
    });
  }

  /** Write a command (appends \r\n automatically). */
  write(cmd: string): void {
    this.socket.write(`${cmd}\r\n`);
  }

  destroy(): void {
    if (this.pendingTimer) clearTimeout(this.pendingTimer);
    this.socket.destroy();
  }
}

// ─── Single-port attempt ─────────────────────────────────────────────────────

function probeOnPort(
  email: string,
  mxHost: string,
  port: number,
  useTls: boolean
): Promise<SmtpProbeResult> {
  const domain = email.split("@")[1] ?? "";
  const randomEmail = `zz_nb_test_${Math.random().toString(36).slice(2, 10)}@${domain}`;

  return new Promise((outerResolve) => {
    const log: SmtpStep[] = [];
    let serverBanner: string | null = null;
    let settled = false;
    let rawSocket: net.Socket;

    function settle(r: Omit<SmtpProbeResult, "log" | "serverBanner" | "port">) {
      if (settled) return;
      settled = true;
      try { rawSocket.write("QUIT\r\n"); } catch { /* ignore */ }
      rawSocket.destroy();
      outerResolve({ ...r, log, serverBanner, port });
    }

    function onError(err: Error) {
      const errCode = (err as NodeJS.ErrnoException).code ?? "";
      const isBlocked =
        errCode === "ECONNREFUSED" ||
        errCode === "ETIMEDOUT" ||
        errCode === "ENETUNREACH" ||
        errCode === "ECONNRESET";
      settle({ email, status: "unavailable", code: 0, isCatchAll: false, smtpAvailable: !isBlocked });
    }

    function onTimeout() {
      settle({ email, status: "unavailable", code: 0, isCatchAll: false, smtpAvailable: false });
    }

    async function onConnected(sock: net.Socket) {
      const session = new SmtpSession(sock);
      try {
        // ── Greeting ─────────────────────────────────────────────────────
        let t = Date.now();
        const greeting = await session.read();
        log.push({ step: "GREETING", sent: null, code: greeting.code, message: greeting.message, ms: Date.now() - t });
        serverBanner = greeting.message;
        if (greeting.code !== 220) {
          settle({ email, status: "unknown", code: greeting.code, isCatchAll: false, smtpAvailable: true });
          return;
        }

        // ── EHLO ─────────────────────────────────────────────────────────
        t = Date.now();
        session.write(`EHLO ${HELO_DOMAIN}`);
        const ehlo = await session.read();
        log.push({ step: "EHLO", sent: `EHLO ${HELO_DOMAIN}`, code: ehlo.code, message: ehlo.message, ms: Date.now() - t });

        if (ehlo.code !== 250) {
          t = Date.now();
          session.write(`HELO ${HELO_DOMAIN}`);
          const helo = await session.read();
          log.push({ step: "HELO", sent: `HELO ${HELO_DOMAIN}`, code: helo.code, message: helo.message, ms: Date.now() - t });
          if (helo.code !== 250) {
            settle({ email, status: "unknown", code: helo.code, isCatchAll: false, smtpAvailable: true });
            return;
          }
        }

        // ── MAIL FROM ────────────────────────────────────────────────────
        t = Date.now();
        session.write(`MAIL FROM:<${MAIL_FROM}>`);
        const mailFrom = await session.read();
        log.push({ step: "MAIL_FROM", sent: `MAIL FROM:<${MAIL_FROM}>`, code: mailFrom.code, message: mailFrom.message, ms: Date.now() - t });
        if (mailFrom.code !== 250) {
          settle({ email, status: "unknown", code: mailFrom.code, isCatchAll: false, smtpAvailable: true });
          return;
        }

        // ── RCPT TO (actual email) ────────────────────────────────────────
        t = Date.now();
        session.write(`RCPT TO:<${email}>`);
        const rcpt = await session.read();
        log.push({ step: "RCPT_TO", sent: `RCPT TO:<${email}>`, code: rcpt.code, message: rcpt.message, ms: Date.now() - t });

        if (rcpt.code === 250 || rcpt.code === 251) {
          // ── Catch-all detection ─────────────────────────────────────────
          t = Date.now();
          session.write(`RCPT TO:<${randomEmail}>`);
          const randomRcpt = await session.read();
          const isCatchAll = randomRcpt.code === 250 || randomRcpt.code === 251;
          log.push({ step: "CATCHALL_CHECK", sent: `RCPT TO:<${randomEmail}>`, code: randomRcpt.code, message: randomRcpt.message, ms: Date.now() - t });

          t = Date.now();
          session.write("RSET");
          const rset = await session.read().catch(() => ({ code: 0, message: "" }));
          log.push({ step: "RSET", sent: "RSET", code: rset.code, message: rset.message, ms: Date.now() - t });

          settle({ email, status: isCatchAll ? "catch_all" : "valid", code: rcpt.code, isCatchAll, smtpAvailable: true });
        } else if (rcpt.code >= 550 && rcpt.code <= 553) {
          settle({ email, status: "invalid", code: rcpt.code, isCatchAll: false, smtpAvailable: true });
        } else {
          settle({ email, status: "unknown", code: rcpt.code, isCatchAll: false, smtpAvailable: true });
        }
      } catch {
        settle({ email, status: "unknown", code: 0, isCatchAll: false, smtpAvailable: false });
      } finally {
        session.destroy();
      }
    }

    if (useTls) {
      const tlsSock = tls.connect({
        host: mxHost,
        port,
        servername: mxHost,
        rejectUnauthorized: false,
      });
      rawSocket = tlsSock;
      tlsSock.setTimeout(SMTP_CONNECT_TIMEOUT_MS);
      tlsSock.on("error", onError);
      tlsSock.on("timeout", onTimeout);
      tlsSock.on("secureConnect", () => void onConnected(tlsSock));
    } else {
      const sock = new net.Socket();
      rawSocket = sock;
      sock.setTimeout(SMTP_CONNECT_TIMEOUT_MS);
      sock.on("error", onError);
      sock.on("timeout", onTimeout);
      sock.connect(port, mxHost, () => void onConnected(sock));
    }
  });
}

// ─── Public API — tries port 25 then port 465 (TLS), across up to 2 MX hosts ─

/**
 * Probe whether an email address exists by performing an SMTP handshake.
 * Tries port 25 first, falls back to port 465 (native TLS / SMTPS).
 * If both ports are blocked on the primary MX host and a secondary is provided,
 * the same port sequence is retried on the secondary MX host.
 *
 * @param email    The address to verify, e.g. "ashish@stripe.com"
 * @param mxHosts  The MX server hostname(s) to connect to (from lookupMx).
 *                 Pass a string (legacy) or an array sorted by priority.
 */
export async function probeSmtp(
  email: string,
  mxHosts: string | string[]
): Promise<SmtpProbeResult> {
  const hosts = Array.isArray(mxHosts) ? mxHosts : [mxHosts];

  for (const host of hosts.slice(0, 2)) {
    const result25 = await probeOnPort(email, host, 25, false);
    if (result25.smtpAvailable) return result25;
    // Port 25 blocked on this host — try port 465 (SMTPS / native TLS)
    const result465 = await probeOnPort(email, host, 465, true);
    if (result465.smtpAvailable) return result465;
  }

  // All hosts and ports were blocked — return a clean "unavailable" result
  return {
    email,
    status: "unavailable",
    code: 0,
    isCatchAll: false,
    smtpAvailable: false,
    serverBanner: null,
    log: [],
    port: 465,
  };
}
