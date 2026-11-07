import { defaultTitleFromFileName, generatePublicId } from './public-id.util';

describe('generatePublicId', () => {
  it('should produce 11 characters from the base64url alphabet', () => {
    for (let i = 0; i < 200; i++) {
      expect(generatePublicId()).toMatch(/^[A-Za-z0-9_-]{11}$/);
    }
  });

  it('should not repeat across many generations', () => {
    const ids = new Set(Array.from({ length: 1000 }, generatePublicId));
    expect(ids.size).toBe(1000);
  });
});

describe('defaultTitleFromFileName', () => {
  it('should drop the extension', () => {
    expect(defaultTitleFromFileName('aula.mp4', 100)).toBe('aula');
    expect(defaultTitleFromFileName('minha.aula.final.mov', 100)).toBe(
      'minha.aula.final',
    );
  });

  it('should keep names without an extension or starting with a dot', () => {
    expect(defaultTitleFromFileName('aula', 100)).toBe('aula');
    expect(defaultTitleFromFileName('.mp4', 100)).toBe('.mp4');
  });

  it('should cap the title to the maximum length', () => {
    expect(defaultTitleFromFileName(`${'a'.repeat(150)}.mp4`, 100)).toBe(
      'a'.repeat(100),
    );
  });
});
