import { render } from '@testing-library/react';
import { useRef } from 'react';
import { useStickyOffset } from './useStickyOffset';

function Probe({ attach = true, contents = false }: Readonly<{ attach?: boolean; contents?: boolean }>) {
  const ref = useRef<HTMLDivElement>(null);
  useStickyOffset(ref);
  if (!attach) return null;
  return (
    <div ref={ref} data-testid="bar" style={contents ? { display: 'contents' } : undefined}>
      <aside style={{ position: 'sticky' }}>banner</aside>
      <header>header</header>
    </div>
  );
}

const offset = () => document.documentElement.style.getPropertyValue('--sticky-offset');

describe('useStickyOffset', () => {
  const original = globalThis.ResizeObserver;
  let notify: () => void = () => {};
  const disconnect = vi.fn();

  beforeEach(() => {
    disconnect.mockClear();
    globalThis.ResizeObserver = class {
      constructor(cb: () => void) {
        notify = cb;
      }
      observe() {}
      unobserve() {}
      disconnect = disconnect;
    } as unknown as typeof ResizeObserver;
  });
  afterEach(() => {
    globalThis.ResizeObserver = original;
  });

  it('publishes the element height, follows resizes and cleans up', () => {
    let height = 96;
    vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockImplementation(() => height);
    const resize = vi.spyOn(window, 'addEventListener');
    const { unmount } = render(<Probe />);
    expect(offset()).toBe('96px');
    height = 140;
    notify();
    expect(offset()).toBe('140px');
    height = 150;
    window.dispatchEvent(new Event('resize'));
    expect(offset()).toBe('150px');
    expect(resize).toHaveBeenCalledWith('resize', expect.any(Function));
    unmount();
    expect(disconnect).toHaveBeenCalled();
    expect(offset()).toBe('');
    vi.restoreAllMocks();
  });

  it('counts only the sticky children when the wrapper is display: contents', () => {
    vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockImplementation(function (this: HTMLElement) {
      return this.tagName === 'ASIDE' ? 64 : 150;
    });
    render(<Probe contents />);
    expect(offset()).toBe('64px');
    vi.restoreAllMocks();
  });

  it('does nothing without an element', () => {
    render(<Probe attach={false} />);
    expect(offset()).toBe('');
  });
});
