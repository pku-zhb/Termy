import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

test('Sixel image canvas is part of the positioned xterm canvas stack', () => {
  const styles = fs.readFileSync(new URL('../styles.css', import.meta.url), 'utf8');
  const rule = styles.match(
    /\.terminal-container \.xterm \.xterm-screen \.xterm-image-layer\s*\{([^}]*)\}/,
  );

  assert.ok(rule, 'missing xterm image-layer rule');
  assert.match(rule[1], /position:\s*absolute\s*;/);
  assert.match(rule[1], /top:\s*0\s*;/);
  assert.match(rule[1], /left:\s*0\s*;/);
  assert.match(rule[1], /z-index:\s*0\s*;/);
});

test('Kitty image layer preserves transparent pixels above the text canvas', () => {
  const styles = fs.readFileSync(new URL('../styles.css', import.meta.url), 'utf8');
  const layerRule = styles.match(
    /\.terminal-container \.xterm \.xterm-screen \.termy-kitty-image-layer\s*\{([^}]*)\}/,
  );
  const imageRule = styles.match(
    /\.terminal-container \.xterm \.xterm-screen \.termy-kitty-image\s*\{([^}]*)\}/,
  );

  assert.ok(layerRule, 'missing Kitty image-layer rule');
  assert.match(layerRule[1], /position:\s*absolute\s*;/);
  assert.match(layerRule[1], /z-index:\s*0\s*;/);
  assert.match(layerRule[1], /pointer-events:\s*none\s*;/);
  assert.ok(imageRule, 'missing Kitty image rule');
  assert.match(imageRule[1], /position:\s*absolute\s*;/);
  assert.match(imageRule[1], /object-fit:\s*fill\s*;/);
});
