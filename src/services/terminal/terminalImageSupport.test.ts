import test from 'node:test';
import assert from 'node:assert/strict';

import {
  createTerminalImageAddonOptions,
  SIXEL_IMAGE_STORAGE_LIMIT_MB,
} from './terminalImageSupport.ts';

test('terminal image support advertises Sixel without enabling iTerm images', async () => {
  Object.defineProperty(globalThis, 'self', {
    configurable: true,
    value: globalThis,
  });
  const [xtermModule, imageModule] = await Promise.all([
    import('@xterm/xterm'),
    import('@xterm/addon-image'),
  ]);
  const xtermExports = xtermModule as unknown as {
    Terminal?: typeof import('@xterm/xterm').Terminal;
    default?: { Terminal?: typeof import('@xterm/xterm').Terminal };
  };
  const imageExports = imageModule as unknown as {
    ImageAddon?: typeof import('@xterm/addon-image').ImageAddon;
    default?: { ImageAddon?: typeof import('@xterm/addon-image').ImageAddon };
  };
  const Terminal = xtermExports.Terminal ?? xtermExports.default?.Terminal;
  const ImageAddon = imageExports.ImageAddon ?? imageExports.default?.ImageAddon;
  assert.ok(Terminal);
  assert.ok(ImageAddon);
  const options = createTerminalImageAddonOptions();
  const terminal = new Terminal({ allowProposedApi: true });

  terminal.loadAddon(new ImageAddon(options));

  let response = '';
  terminal.onData((data) => {
    response += data;
  });
  terminal.write('\x1b[c');
  await new Promise((resolve) => setTimeout(resolve, 20));

  assert.equal(response, '\x1b[?62;4;9;22c');
  assert.equal(options.sixelSupport, true);
  assert.equal(options.iipSupport, false);
  assert.equal(options.storageLimit, SIXEL_IMAGE_STORAGE_LIMIT_MB);
  terminal.dispose();
});
