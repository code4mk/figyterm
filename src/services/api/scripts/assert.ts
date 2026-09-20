/**
 * The assertions a collection's test scripts are written against.
 *
 * Real scripts in this format are written in a chai dialect —
 * `pm.expect(body.id).to.be.a("string")`, `pm.response.to.have.status(200)` —
 * and a client that does not understand it cannot run anybody's existing tests.
 * Importing a collection perfectly and then failing every assertion in it would
 * be a strange kind of compatibility.
 *
 * This is a subset, not chai: the words that appear in practice, implemented
 * exactly, with messages that say what was expected and what was there. An
 * unknown matcher throws by name rather than passing quietly, because a test
 * that passes because nobody implemented it is worse than one that errors.
 *
 * Pure, and tested under Node — which is the whole reason it is a module of its
 * own rather than something assembled inside the sandbox.
 */

/** Thrown by a failed expectation. Named so the runner can tell an assertion
 * failure from a script that simply broke. */
export class AssertionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AssertionError";
  }
}

/** `"a string"`, `42`, `{…}` — short enough for a one-line failure message. */
export function show(value: unknown): string {
  if (typeof value === "string") return JSON.stringify(value);
  if (value === undefined) return "undefined";
  if (value === null) return "null";
  if (typeof value === "function") return "a function";
  try {
    const text = JSON.stringify(value);
    return text.length > 120 ? `${text.slice(0, 119)}…` : text;
  } catch {
    return String(value);
  }
}

/** Deep equality, for `eql` and `deep.equal`. */
export function deepEqual(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;

  const left = a as Record<string, unknown>;
  const right = b as Record<string, unknown>;
  const keys = Object.keys(left);
  if (keys.length !== Object.keys(right).length) return false;
  return keys.every(
    (key) =>
      Object.prototype.hasOwnProperty.call(right, key) && deepEqual(left[key], right[key])
  );
}

/** What `to.be.a(…)` compares against, including the two JavaScript lies. */
export function typeOf(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}

/**
 * One expectation, with the fluent words chained off it.
 *
 * The connecting words — `to`, `be`, `have`, `that`, `and`, `which` — all
 * return the same object, which is what makes the dialect read as English
 * while staying an ordinary method chain.
 */
export class Expectation {
  constructor(
    private readonly value: unknown,
    private readonly negated = false,
    private readonly isDeep = false,
    private readonly label = "value"
  ) {}

  // ─── Connecting words ──────────────────────────────────────────────────

  get to(): this {
    return this;
  }
  get be(): this {
    return this;
  }
  get been(): this {
    return this;
  }
  get is(): this {
    return this;
  }
  get that(): this {
    return this;
  }
  get which(): this {
    return this;
  }
  get and(): this {
    return this;
  }
  get have(): this {
    return this;
  }
  get has(): this {
    return this;
  }
  get with(): this {
    return this;
  }
  /** `at` carries `at.least` and `at.most`; `of` carries `length.of(3)`. */
  get at(): this {
    return this;
  }
  get of(): this {
    return this;
  }

  /** Everything after this is inverted. */
  get not(): Expectation {
    return new Expectation(this.value, !this.negated, this.isDeep, this.label);
  }

  /** `deep.equal` compares structures rather than references. */
  get deep(): Expectation {
    return new Expectation(this.value, this.negated, true, this.label);
  }

  /** Fails unless `passed` matches what negation asks for. */
  private check(passed: boolean, expected: string): void {
    if (passed !== this.negated) return;
    const not = this.negated ? "not " : "";
    throw new AssertionError(
      `expected ${this.label} ${show(this.value)} ${not}to ${expected}`
    );
  }

  // ─── Matchers ──────────────────────────────────────────────────────────

  equal(expected: unknown): this {
    const passed = this.isDeep ? deepEqual(this.value, expected) : Object.is(this.value, expected);
    this.check(passed, `equal ${show(expected)}`);
    return this;
  }

  /** chai's alias for a deep comparison, and the one scripts reach for. */
  eql(expected: unknown): this {
    this.check(deepEqual(this.value, expected), `deeply equal ${show(expected)}`);
    return this;
  }

  /** `to.be.a("string")`, and `an` for the ones that read better with it.
   * Both are methods rather than connecting words: `to.be.an("array")` is by
   * far the commonest use, and a getter there is a call on an object. */
  a(type: string): this {
    this.check(typeOf(this.value) === type.toLowerCase(), `be a ${type}`);
    return this;
  }

  an(type: string): this {
    return this.a(type);
  }

  get ok(): this {
    this.check(Boolean(this.value), "be truthy");
    return this;
  }
  get true(): this {
    this.check(this.value === true, "be true");
    return this;
  }
  get false(): this {
    this.check(this.value === false, "be false");
    return this;
  }
  get null(): this {
    this.check(this.value === null, "be null");
    return this;
  }
  get undefined(): this {
    this.check(this.value === undefined, "be undefined");
    return this;
  }
  get empty(): this {
    const size =
      typeof this.value === "string" || Array.isArray(this.value)
        ? (this.value as string | unknown[]).length
        : Object.keys((this.value ?? {}) as object).length;
    this.check(size === 0, "be empty");
    return this;
  }

  property(name: string, expected?: unknown): Expectation {
    const object = (this.value ?? {}) as Record<string, unknown>;
    const present = typeof this.value === "object" && this.value !== null && name in object;
    this.check(present, `have a property ${show(name)}`);

    if (expected !== undefined && present) {
      const actual = object[name];
      const passed = this.isDeep ? deepEqual(actual, expected) : Object.is(actual, expected);
      if (passed === this.negated) {
        throw new AssertionError(
          `expected ${show(name)} to be ${show(expected)} but it was ${show(actual)}`
        );
      }
    }

    // The chain continues on the property, which is how
    // `have.property("a").that.is.a("string")` works.
    return new Expectation(object[name], false, this.isDeep, `property ${show(name)}`);
  }

  /** The assertion itself, so the two chainable properties below can call it
   * without going back through their own getters. */
  private assertLength(expected: number): this {
    const actual = (this.value as { length?: number } | null)?.length;
    this.check(actual === expected, `have length ${expected} but it was ${show(actual)}`);
    return this;
  }

  /**
   * `lengthOf` is two things in chai, and real scripts use both.
   *
   * `to.have.lengthOf(3)` asserts the length outright. `to.have.lengthOf.at
   * .least(1)` instead moves the chain *onto* the length, so the numeric
   * matchers that follow compare against it rather than against the value it
   * came from — that is how `expect("abc").to.have.lengthOf.at.least(1)` is
   * about 3 and not about `"abc"`.
   *
   * A plain method gives you the first and makes the second a TypeError on
   * `.at`, which is exactly what
   * `.to.be.a('string').and.to.have.lengthOf.at.least(1)` hit: `.lengthOf` was
   * a function, functions have no `.at`, and `undefined.least` threw.
   *
   * So it is a getter returning something both callable and chainable — a
   * proxy whose call is the assertion and whose properties are an expectation
   * about the length.
   */
  get lengthOf(): LengthAssertion {
    return this.lengthChain();
  }

  /** chai spells it both ways, and `length.of.at.least(1)` is the older idiom. */
  get length(): LengthAssertion {
    return this.lengthChain();
  }

  private lengthChain(): LengthAssertion {
    const size = (this.value as { length?: number } | null | undefined)?.length;
    const onLength = new Expectation(
      size,
      this.negated,
      this.isDeep,
      `${this.label} length`
    );
    const call = (expected: number) => this.assertLength(expected);

    return new Proxy(call, {
      get(fn, key, receiver) {
        // Anything the expectation knows answers about the length; everything
        // else (`name`, `call`, symbols) stays the function's own.
        if (key in onLength) {
          const member = (onLength as unknown as Record<string | symbol, unknown>)[key];
          return typeof member === "function" ? member.bind(onLength) : member;
        }
        return Reflect.get(fn, key, receiver);
      },
    }) as unknown as LengthAssertion;
  }

  include(expected: unknown): this {
    const passed =
      typeof this.value === "string"
        ? this.value.includes(String(expected))
        : Array.isArray(this.value)
          ? this.value.some((entry) => deepEqual(entry, expected))
          : false;
    this.check(passed, `include ${show(expected)}`);
    return this;
  }

  contain(expected: unknown): this {
    return this.include(expected);
  }

  match(pattern: RegExp): this {
    this.check(pattern.test(String(this.value)), `match ${pattern}`);
    return this;
  }

  above(limit: number): this {
    this.check(Number(this.value) > limit, `be above ${limit}`);
    return this;
  }

  below(limit: number): this {
    this.check(Number(this.value) < limit, `be below ${limit}`);
    return this;
  }

  least(limit: number): this {
    this.check(Number(this.value) >= limit, `be at least ${limit}`);
    return this;
  }

  most(limit: number): this {
    this.check(Number(this.value) <= limit, `be at most ${limit}`);
    return this;
  }

  within(min: number, max: number): this {
    const actual = Number(this.value);
    this.check(actual >= min && actual <= max, `be within ${min} and ${max}`);
    return this;
  }

  oneOf(options: unknown[]): this {
    this.check(
      options.some((option) => deepEqual(option, this.value)),
      `be one of ${show(options)}`
    );
    return this;
  }
}

/**
 * What `.lengthOf` and `.length` hand back: callable like the method they used
 * to be, chainable like an expectation about the length.
 */
export interface LengthAssertion extends Expectation {
  (expected: number): Expectation;
}

export function expect(value: unknown, label = "value"): Expectation {
  return new Expectation(value, false, false, label);
}
