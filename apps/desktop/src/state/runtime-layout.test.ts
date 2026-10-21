import { describe, expect, it } from 'vitest';
import stylesheet from '../styles.css?raw';

// Structural CSS contract only. Pixel layout, wrapping and focus rendering still
// require the hosted packaged GUI screenshots; jsdom is not a layout engine.
function declarations(selector: string): string[] {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
  return [...stylesheet.matchAll(new RegExp(`${escaped}\\s*\\{([^}]*)\\}`, 'gu'))].map(
    (match) => match[1] ?? '',
  );
}

describe('runtime panel layout contract', () => {
  it('keeps an auto runtime row before the sole flexible main row at both breakpoints', () => {
    const rows = declarations('.app-shell').map(
      (rule) => rule.match(/grid-template-rows:\s*([^;]+);/u)?.[1],
    );
    expect(rows).toEqual(['56px auto minmax(0, 1fr)', '50px auto minmax(0, 1fr)']);
    expect(declarations('.runtime-strip')[0]).toContain('min-height: var(--runtime-strip-height)');
    expect(declarations('.runtime-recovery[hidden]')[0]).toContain('display: none');
  });

  it('bounds long recovery content and gives context controls explicit spacing and focus', () => {
    expect(declarations('.runtime-panel')[0]).toContain('max-height: min(45vh, 360px)');
    expect(declarations('.runtime-panel')[0]).toContain('overflow-y: auto');
    expect(declarations('.runtime-recovery')[0]).toContain('overflow-wrap: anywhere');
    expect(declarations('.runtime-context')[0]).toContain('flex-wrap: wrap');
    expect(declarations('.runtime-context')[0]).toContain('gap: 8px 20px');
    expect(declarations('.runtime-actor')[0]).toContain('gap: 8px');
    expect(declarations('.runtime-recovery button:focus-visible')[0]).toContain(
      'outline: 2px solid',
    );
  });
});
