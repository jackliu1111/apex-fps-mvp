"""Build separate diagnostic runtime from the pinned sparse runtime. No vendor overwrite."""
from pathlib import Path
import hashlib
vendor = Path('/private/tmp/apex-browser-prototype-20261026/assets/vendor')
text = (vendor / 'mediabunny-sparse.mjs').read_text()
assert hashlib.sha256(text.encode()).hexdigest() == '1c7c2b0a682e343829410b1c966a4fe2de082932a66a6d7b37d0ef219327158b'
anchor = '  async apexReadAudioCluster(start, end, trackId) {'
assert text.count(anchor) == 1
text = text.replace(anchor, anchor + '''
    if (this.reader.source._apexClusterPrefetch) {
      const parts = await this.reader.source._apexClusterPrefetch.take(start, end, trackId);
      if (parts) {
        for (const { start: offset, data } of parts) {
          this.traverseElement(new FileSlice4(data, new DataView(data.buffer, data.byteOffset, data.byteLength), offset, offset, offset + data.length));
        }
        return;
      }
    }
''')
path = vendor / 'mediabunny-concurrent.mjs'
path.write_text(text)
print(path, len(text.encode()), hashlib.sha256(text.encode()).hexdigest())
