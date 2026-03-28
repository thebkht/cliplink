import { errorResponse } from "@/lib/cliplink/errors";
import { storage } from "@/lib/cliplink/storage";
import { validateRoomCode } from "@/lib/cliplink/validation";

const encoder = new TextEncoder();
const STREAM_POLL_MS = 250;
const KEEPALIVE_MS = 15_000;

function eventChunk(type: string, data: string, id?: string) {
  const lines = [];
  if (id) {
    lines.push(`id: ${id}`);
  }
  lines.push(`event: ${type}`);
  lines.push(`data: ${data}`);
  return `${lines.join("\n")}\n\n`;
}

function commentChunk(comment: string) {
  return `: ${comment}\n\n`;
}

export async function GET(
  request: Request,
  context: RouteContext<"/rooms/[code]/stream">,
) {
  const { code } = await context.params;
  if (!validateRoomCode(code)) {
    return errorResponse(400, "invalid_room_code", "Invalid room code.");
  }

  const room = await storage.getRoom(code);
  if (!room) {
    return errorResponse(404, "room_not_found", "Room not found.");
  }

  const url = new URL(request.url);
  const requestedAfter = Number(
    request.headers.get("last-event-id") ??
      url.searchParams.get("after") ??
      "0",
  );
  let lastSeenId = Number.isFinite(requestedAfter) && requestedAfter >= 0
    ? requestedAfter
    : 0;

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode(commentChunk("connected")));

      const interval = setInterval(async () => {
        try {
          const clips = await storage.getClipsAfter(code, lastSeenId);
          if (!clips) {
            controller.enqueue(
              encoder.encode(
                eventChunk(
                  "stream-error",
                  JSON.stringify({ code: "room_not_found" }),
                ),
              ),
            );
            clearInterval(interval);
            clearInterval(keepalive);
            controller.close();
            return;
          }

          for (const clip of clips) {
            lastSeenId = Math.max(lastSeenId, clip.id);
            controller.enqueue(
              encoder.encode(
                eventChunk("clip", JSON.stringify(clip), String(clip.id)),
              ),
            );
          }
        } catch {
          controller.enqueue(
            encoder.encode(
              eventChunk(
                "stream-error",
                JSON.stringify({ code: "stream_failed" }),
              ),
            ),
          );
          clearInterval(interval);
          clearInterval(keepalive);
          controller.close();
        }
      }, STREAM_POLL_MS);

      const keepalive = setInterval(() => {
        controller.enqueue(encoder.encode(commentChunk("ping")));
      }, KEEPALIVE_MS);

      request.signal.addEventListener("abort", () => {
        clearInterval(interval);
        clearInterval(keepalive);
        controller.close();
      });
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}
