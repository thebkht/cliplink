import { noStoreJson } from "@/lib/cliplink/errors";
import { storage } from "@/lib/cliplink/storage";
import type { CreateRoomResponse } from "@/lib/cliplink/types";

export async function POST() {
  const room = await storage.createRoom();
  const response: CreateRoomResponse = {
    code: room.code,
  };

  return noStoreJson(response, { status: 201 });
}
