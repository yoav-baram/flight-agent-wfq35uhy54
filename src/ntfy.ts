const NTFY_BASE_URL = "https://ntfy.sh";

export class NtfyApiError extends Error {
  status?: number;

  constructor(message: string, status?: number) {
    super(message);
    this.name = "NtfyApiError";
    this.status = status;
  }
}

function getTopic(): string {
  const topic = process.env.NTFY_TOPIC;
  if (!topic) {
    throw new NtfyApiError("NTFY_TOPIC environment variable is not set.");
  }
  return topic;
}

export async function sendNtfyNotification(
  title: string,
  message: string
): Promise<void> {
  const topic = getTopic();

  let response: Response;
  try {
    response = await fetch(`${NTFY_BASE_URL}/${encodeURIComponent(topic)}`, {
      method: "POST",
      headers: {
        Title: title,
        "Content-Type": "text/plain; charset=utf-8",
      },
      body: message,
    });
  } catch (error) {
    throw new NtfyApiError(
      `Failed to reach ntfy API: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
  }

  if (!response.ok) {
    let details: string | undefined;
    try {
      details = await response.text();
    } catch {
      // response body wasn't readable; fall through with no details
    }

    const errorMessage =
      details || `ntfy API request failed with status ${response.status}`;

    throw new NtfyApiError(errorMessage, response.status);
  }
}
