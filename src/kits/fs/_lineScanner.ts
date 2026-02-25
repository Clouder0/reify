export type LineScanSink = {
  /** Called with line content segments (no line ending characters). */
  onContent: (segment: string) => boolean | void;

  /** Called when a line ends. `eol` is "\n", "\r", "\r\n", or "" at EOF. */
  onLineEnd: (eol: string) => boolean | void;
};

// A streaming line scanner that preserves CRLF/LF/CR endings.
//
// Important: this does not buffer entire lines. Callers can choose what to retain.
export class LineScanner {
  private pendingCR = false;
  private sawContentSinceLineStart = false;
  private stopped = false;

  write(chunk: string, sink: LineScanSink): boolean {
    if (this.stopped) return true;
    if (chunk.length === 0) return false;

    let text = chunk;

    if (this.pendingCR) {
      this.pendingCR = false;
      if (text.startsWith("\n")) {
        if (sink.onLineEnd("\r\n") === true) {
          this.stopped = true;
          return true;
        }
        this.sawContentSinceLineStart = false;
        text = text.slice(1);
      } else {
        if (sink.onLineEnd("\r") === true) {
          this.stopped = true;
          return true;
        }
        this.sawContentSinceLineStart = false;
      }
    }

    let start = 0;
    for (let i = 0; i < text.length; i += 1) {
      const ch = text.charCodeAt(i);
      if (ch !== 10 && ch !== 13) continue;

      if (i > start) {
        this.sawContentSinceLineStart = true;
        if (sink.onContent(text.slice(start, i)) === true) {
          this.stopped = true;
          return true;
        }
      }

      if (ch === 13) {
        if (i + 1 === text.length) {
          // Potential CRLF split across chunks.
          this.pendingCR = true;
          return false;
        }
        if (text.charCodeAt(i + 1) === 10) {
          if (sink.onLineEnd("\r\n") === true) {
            this.stopped = true;
            return true;
          }
          this.sawContentSinceLineStart = false;
          i += 1;
          start = i + 1;
          continue;
        }

        if (sink.onLineEnd("\r") === true) {
          this.stopped = true;
          return true;
        }
        this.sawContentSinceLineStart = false;
        start = i + 1;
        continue;
      }

      // LF
      if (sink.onLineEnd("\n") === true) {
        this.stopped = true;
        return true;
      }
      this.sawContentSinceLineStart = false;
      start = i + 1;
    }

    if (start < text.length) {
      this.sawContentSinceLineStart = true;
      if (sink.onContent(text.slice(start)) === true) {
        this.stopped = true;
        return true;
      }
    }

    return false;
  }

  end(sink: LineScanSink): boolean {
    if (this.stopped) return true;

    if (this.pendingCR) {
      this.pendingCR = false;
      if (sink.onLineEnd("\r") === true) {
        this.stopped = true;
        return true;
      }
      this.sawContentSinceLineStart = false;
    }

    if (this.sawContentSinceLineStart) {
      this.sawContentSinceLineStart = false;
      if (sink.onLineEnd("") === true) {
        this.stopped = true;
        return true;
      }
    }

    return false;
  }
}
