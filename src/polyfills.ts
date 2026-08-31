/**
 * pdf.js v4 uses Promise.withResolvers, which Safari only shipped in 17.4.
 * This app is aimed at phones driving an external monitor, so older iOS is
 * squarely in scope. Imported first from main.tsx, before pdf.js is evaluated.
 */
type WithResolvers = <T>() => {
  promise: Promise<T>;
  resolve: (value: T | PromiseLike<T>) => void;
  reject: (reason?: unknown) => void;
};

const target = Promise as PromiseConstructor & { withResolvers?: WithResolvers };

if (typeof target.withResolvers !== 'function') {
  target.withResolvers = function withResolvers<T>() {
    let resolve!: (value: T | PromiseLike<T>) => void;
    let reject!: (reason?: unknown) => void;
    const promise = new Promise<T>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    return { promise, resolve, reject };
  };
}

export {};
