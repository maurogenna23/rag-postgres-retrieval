/**
 * Sentence-aware chunker. Copied unchanged from the production engine.
 *
 * Splits on sentence terminators and accumulates until a 500-word target, with
 * a hard floor of 300 and a ceiling of 800. The floor matters more than it
 * looks: a 40-word chunk ranks highly on ts_rank for almost any query that
 * touches it, because rank is normalised by document length, so a corpus full
 * of tiny chunks retrieves noise.
 *
 * Sentences are rejoined with blank lines rather than spaces so Markdown
 * structure (## headings, **bold**) survives indexing and is still readable
 * when a chunk is shown back to a user.
 */

export interface TextChunk {
  content: string;
  wordCount: number;
  chunkIndex: number;
}

export class ChunkingUtil {
  private static readonly MIN_CHUNK_WORDS = 300;
  private static readonly MAX_CHUNK_WORDS = 800;
  private static readonly TARGET_CHUNK_WORDS = 500;

  /**
   * Split text into manageable chunks of 300-800 words
   */
  static chunkText(text: string): TextChunk[] {
    // Clean the text
    const cleanedText = this.cleanText(text);

    // Split into sentences
    const sentences = this.splitIntoSentences(cleanedText);

    const chunks: TextChunk[] = [];
    let currentChunk: string[] = [];
    let currentWordCount = 0;
    let chunkIndex = 0;

    for (const sentence of sentences) {
      const sentenceWords = this.countWords(sentence);

      // If adding this sentence exceeds max, save current chunk
      if (
        currentWordCount + sentenceWords > this.MAX_CHUNK_WORDS &&
        currentWordCount >= this.MIN_CHUNK_WORDS
      ) {
        chunks.push({
          content: this.joinChunkSentences(currentChunk),
          wordCount: currentWordCount,
          chunkIndex: chunkIndex++,
        });

        currentChunk = [];
        currentWordCount = 0;
      }

      currentChunk.push(sentence);
      currentWordCount += sentenceWords;

      // If we've reached a good chunk size, consider ending here
      if (currentWordCount >= this.TARGET_CHUNK_WORDS) {
        chunks.push({
          content: this.joinChunkSentences(currentChunk),
          wordCount: currentWordCount,
          chunkIndex: chunkIndex++,
        });

        currentChunk = [];
        currentWordCount = 0;
      }
    }

    // Add remaining content
    if (currentChunk.length > 0) {
      chunks.push({
        content: this.joinChunkSentences(currentChunk),
        wordCount: currentWordCount,
        chunkIndex: chunkIndex++,
      });
    }

    return chunks;
  }

  /**
   * Join sentence pieces into stored chunk text. Use paragraph breaks so Markdown
   * (## headings, **bold**) survives indexing and displays correctly in the UI.
   */
  private static joinChunkSentences(sentences: string[]): string {
    return sentences
      .join('\n\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
  }

  /**
   * Clean text: normalize line endings and horizontal spaces only — never collapse
   * newlines into spaces (that breaks Markdown structure for internal processes).
   */
  private static cleanText(text: string): string {
    return text
      .replace(/\r\n/g, '\n')
      .replace(/\n{3,}/g, '\n\n')
      .replace(/[ \t\f\v]+/g, ' ')
      .replace(/^[ \t]+/gm, '')
      .replace(/[ \t]+$/gm, '')
      .trim();
  }

  /**
   * Split text into sentences
   */
  private static splitIntoSentences(text: string): string[] {
    // Split on common sentence terminators followed by space or newline
    const sentences = text.split(/([.!?]\s+|\n\n)/);

    const result: string[] = [];
    for (let i = 0; i < sentences.length; i += 2) {
      const sentence = sentences[i];
      const terminator = sentences[i + 1] || '';

      if (sentence && sentence.trim()) {
        result.push((sentence + terminator).trim());
      }
    }

    return result.filter((s) => s.length > 0);
  }

  /**
   * Count words in text
   */
  private static countWords(text: string): number {
    return text.split(/\s+/).filter((word) => word.length > 0).length;
  }

  /**
   * Get total word count from text
   */
  static getTotalWordCount(text: string): number {
    return this.countWords(this.cleanText(text));
  }
}
