// Capture the renderer's pixels and timestamp together, before asynchronous decoding.
async function readDisplayedFrame(page, filename) {
  return page.evaluate(async filename => {
    const canvas = document.querySelector('#source-canvas');
    const {width, height} = canvas;
    const time = reviewApp.player.state.actual;
    const pixels = surface => surface.getContext('2d').getImageData(0, 0, width, height).data;
    const displayed = pixels(canvas);
    const {file} = reviewApp.queue.records.find(record => record.file.name === filename);
    const MB = await import('/assets/vendor/mediabunny.mjs');
    const input = new MB.Input({source: new MB.BlobSource(file), formats: MB.ALL_FORMATS});
    try {
      const track = await input.getPrimaryVideoTrack();
      const sink = new MB.CanvasSink(track, {width, height, fit: 'contain'});
      const expected = await sink.getCanvas(await track.getFirstTimestamp() + time + 0.001);
      const reference = pixels(expected.canvas);
      let difference = 0;
      for (let i = 0; i < displayed.length; i++) difference += Math.abs(displayed[i] - reference[i]);
      return {time, error: difference / displayed.length};
    } finally {
      input.dispose();
    }
  }, filename);
}

module.exports = {readDisplayedFrame};
