import { NextRequest, NextResponse } from "next/server";
import { getAllContacts, deleteAllContacts } from "@/lib/db/contacts";

export const runtime = "nodejs";

export async function GET() {
  try {
    const contacts = await getAllContacts();
    return NextResponse.json({ contacts });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

export async function DELETE(req: NextRequest) {
  // Only allow in development or with a secret header for safety
  const authHeader = req.headers.get("x-admin-secret");
  if (authHeader !== process.env.ADMIN_SECRET) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    await deleteAllContacts();
    return NextResponse.json({ success: true });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
