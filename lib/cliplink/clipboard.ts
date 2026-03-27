export async function writeClipboard(text: string) {
  await navigator.clipboard.writeText(text);
}

export async function readClipboard() {
  return navigator.clipboard.readText();
}
