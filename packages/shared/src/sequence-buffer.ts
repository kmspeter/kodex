export interface Sequenced<T> {
  sequence: number;
  value: T;
}

export class SequenceBuffer<T> {
  #sequence = 0;
  #entries: Sequenced<T>[] = [];

  constructor(readonly capacity = 1_000) {}

  get sequence(): number {
    return this.#sequence;
  }

  push(value: T): Sequenced<T> {
    const entry = { sequence: ++this.#sequence, value };
    this.#entries.push(entry);
    if (this.#entries.length > this.capacity) this.#entries.splice(0, this.#entries.length - this.capacity);
    return entry;
  }

  after(sequence: number): Sequenced<T>[] {
    return this.#entries.filter((entry) => entry.sequence > sequence);
  }

  get oldestSequence(): number {
    return this.#entries[0]?.sequence ?? this.#sequence;
  }
}
