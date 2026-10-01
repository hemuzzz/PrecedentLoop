/** markdown-it (html:false) emits only these three table alignment styles.
 * Use classes at the HTML insertion boundary so strict style-src remains intact.
 * This is presentation normalization, not a substitute for html:false. */
export function markdownPresentation(html: string): string {
  return html.replace(/ style="text-align:(left|center|right)"/gu, ' class="markdown-align-$1"');
}
