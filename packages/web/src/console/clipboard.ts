/** Puts text on the clipboard. False when the browser refused. */
export const copyText = async (text: string): Promise<boolean> => {
  try {
    await navigator.clipboard.writeText(text);

    return true;
  }
  catch {
    return false;
  }
};
