import assert from 'node:assert/strict';
import test from 'node:test';

import {
  calculateKittyGraphicsLayout,
  KittyGraphicsProtocolBridge,
  TERMY_KITTY_GRAPHICS_OSC,
} from './kittyGraphicsSupport.ts';

const markerPrefix = `\x1b]${TERMY_KITTY_GRAPHICS_OSC};`;

function extractMarkers(output: string): string[] {
  const markers: string[] = [];
  let offset = 0;
  while (true) {
    const start = output.indexOf(markerPrefix, offset);
    if (start === -1) {
      return markers;
    }
    const valueStart = start + markerPrefix.length;
    const end = output.indexOf('\x07', valueStart);
    assert.notEqual(end, -1);
    markers.push(output.slice(valueStart, end));
    offset = end + 1;
  }
}

test('Kitty graphics bridge replaces a PNG APC with an ordered OSC marker', () => {
  const bridge = new KittyGraphicsProtocolBridge();
  const output = bridge.transformOutput(
    'before\x1b_Ga=T,t=d,f=100,c=8,r=5,q=2,i=49374,m=0;QUJDRA==\x1b\\after',
  );
  const markers = extractMarkers(output);

  assert.equal(output.startsWith('before'), true);
  assert.equal(output.endsWith('after'), true);
  assert.equal(output.includes('QUJDRA=='), false);
  assert.equal(markers.length, 1);
  assert.deepEqual(
    bridge.consumeMarker(markers[0], { x: 72, y: 18 }),
    {
      handled: true,
      action: {
        type: 'render',
        image: {
          imageId: 49374,
          columns: 8,
          rows: 5,
          x: 72,
          y: 18,
          base64Png: 'QUJDRA==',
        },
      },
    },
  );
});

test('Kitty graphics bridge handles PTY boundaries and chunked image payloads', () => {
  const bridge = new KittyGraphicsProtocolBridge();

  assert.equal(bridge.transformOutput('left\x1b_'), 'left');
  assert.equal(
    bridge.transformOutput('Ga=T,t=d,f=100,c=6,r=4,i=7,m=1;QUJD\x1b'),
    '',
  );
  const output = bridge.transformOutput('\\\x1b_Gm=0;RA==\x1b\\right');
  const markers = extractMarkers(output);

  assert.equal(output.endsWith('right'), true);
  assert.equal(markers.length, 2);
  assert.deepEqual(
    bridge.consumeMarker(markers[0], { x: 30, y: 9 }),
    { handled: true, action: null },
  );
  assert.deepEqual(
    bridge.consumeMarker(markers[1], { x: 99, y: 99 }),
    {
      handled: true,
      action: {
        type: 'render',
        image: {
          imageId: 7,
          columns: 6,
          rows: 4,
          x: 30,
          y: 9,
          base64Png: 'QUJDRA==',
        },
      },
    },
  );
});

test('Kitty graphics bridge converts image deletion commands', () => {
  const bridge = new KittyGraphicsProtocolBridge();
  const output = bridge.transformOutput('\x1b_Ga=d,d=I,i=49374,q=2;\x1b\\');
  const [marker] = extractMarkers(output);

  assert.deepEqual(
    bridge.consumeMarker(marker, { x: 0, y: 0 }),
    {
      handled: true,
      action: { type: 'delete', imageId: 49374 },
    },
  );
  assert.deepEqual(
    bridge.consumeMarker(marker, { x: 0, y: 0 }),
    { handled: false, action: null },
  );
});

test('Kitty graphics bridge leaves unrelated APC strings untouched', () => {
  const bridge = new KittyGraphicsProtocolBridge();
  const input = 'before\x1b_not-kitty\x1b\\after';

  assert.equal(bridge.transformOutput(input), input);
});

test('Kitty graphics layout maps terminal cells to screen pixels', () => {
  assert.deepEqual(
    calculateKittyGraphicsLayout(
      { x: 72, y: 18, columns: 8, rows: 5 },
      80,
      30,
      800,
      600,
    ),
    {
      left: 720,
      top: 360,
      width: 80,
      height: 100,
    },
  );
});
