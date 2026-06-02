/**
 * Human-like pause between browser operations: `baseMs` ± `jitterMs` (uniform),
 * floored at 250ms. Default ~3s ± 1s. Makes automated navigation look less
 * robotic to the server (anti-detection / respectful pacing).
 */
export function humanPause(baseMs = 3000, jitterMs = 1000): Promise<void> {
  const ms = Math.max(250, baseMs + (Math.random() * 2 - 1) * jitterMs);
  return new Promise((resolve) => setTimeout(resolve, ms));
}
