export class JsonlDecoder {
  #buffer = '';

  push(chunk: string | Buffer): string[] {
    this.#buffer += chunk.toString();
    const lines = this.#buffer.split(/\r?\n/);
    this.#buffer = lines.pop() ?? '';
    return lines.filter((line) => line.trim().length > 0);
  }

  flush(): string[] {
    const tail = this.#buffer.trim();
    this.#buffer = '';
    return tail ? [tail] : [];
  }
}
