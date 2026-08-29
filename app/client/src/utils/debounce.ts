export function debounce<Args extends unknown[]>(
  fn: (...args: Args) => void,
  wait = 250
): ((...args: Args) => void) & { cancel: () => void } {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const wrapped = ((...args: Args) => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => fn(...args), wait);
  }) as ((...args: Args) => void) & { cancel: () => void };
  wrapped.cancel = () => {
    if (timer) clearTimeout(timer);
    timer = undefined;
  };
  return wrapped;
}
