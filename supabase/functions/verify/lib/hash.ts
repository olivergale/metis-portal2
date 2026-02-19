// verify/lib/hash.ts
// SHA-256 hashing utilities for /verify edge function

/**
 * Compute SHA-256 hash of a string or object.
 * Returns hex-encoded hash.
 */
export async function sha256(input: string | object): Promise<string> {
  const data =
    typeof input === "string" ? input : JSON.stringify(input);
  const encoded = new TextEncoder().encode(data);
  const hashBuffer = await crypto.subtle.digest("SHA-256", encoded);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map((b) => b.toString(16).padStart(2, "0")).join("");
}
