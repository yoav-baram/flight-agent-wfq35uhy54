const NTFY_BASE_URL = "https://ntfy.sh";

export class NtfyApiError extends Error {
  status?: number;

  constructor(message: string, status?: number) {
    super(message);
    this.name = "NtfyApiError";
    this.status = status;
  }
}

export interface NtfyViewAction {
  label: string;
  url: string;
}

export interface NtfyOptions {
  /* Opened when the notification itself is tapped. */
  click?: string;
  /* Tappable buttons under the notification (ntfy shows at most 3). */
  actions?: NtfyViewAction[];
}

const MAX_ACTIONS = 3;

function getTopic(): string {
  const topic = process.env.NTFY_TOPIC;
  if (!topic) {
    throw new NtfyApiError("NTFY_TOPIC environment variable is not set.");
  }
  return topic;
}

/*
 * Publishes via ntfy's JSON API (rather than plain-text POST with
 * headers) so that titles may contain non-ASCII characters and so
 * the notification can carry a tap target and action buttons - a
 * long URL buried in the message body is not reliably tappable in
 * every ntfy client.
 */
export async function sendNtfyNotification(
  title: string,
  message: string,
  options: NtfyOptions = {}
): Promise<void> {
  const topic = getTopic();

  const body: Record<string, unknown> = {
    topic,
    title,
    message,
  };

  /*
   * ntfy only opens plain http(s) links from a tap - custom app
   * URL schemes (e.g. Chrome's googlechromes://) don't work on the
   * iPhone app. Which browser opens is decided by the phone's
   * default-browser setting, not by this code.
   */
  if (options.click) {
    body.click = options.click;
  }

  if (options.actions && options.actions.length > 0) {
    body.actions = options.actions
      .slice(0, MAX_ACTIONS)
      .map((action) => ({
        action: "view",
        label: action.label,
        url: action.url,
      }));
  }

  let response: Response;
  try {
    response = await fetch(NTFY_BASE_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
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
