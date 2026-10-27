"""Experimental, pinned patch: sparse MKV audio Cluster traversal; original stays intact."""
import hashlib
from pathlib import Path

vendor = Path('/private/tmp/apex-browser-prototype-20261026/assets/vendor')
source = (vendor / 'mediabunny.mjs').read_bytes()
assert hashlib.sha256(source).hexdigest() == '160db974a539ca6303bb614545f2017953be2f5a92bc04464243b0b4cbc0be27', 'Unsupported runtime; review patch first'
text = source.decode()
# 'none' must not bridge discarded video payload between sparse range requests.
assert text.count('const gapTolerance = 2 ** 17;') == 1
text = text.replace('const gapTolerance = 2 ** 17;', 'const gapTolerance = this.options.prefetchProfile === PREFETCH_PROFILES.none ? 0 : 2 ** 17;')
old = '''    let dataSlice = this.reader.requestSlice(dataStartPos, size);
    if (dataSlice instanceof Promise) dataSlice = await dataSlice;
    const cluster = {'''
new = '''    const sparseTrack = this.reader.source._apexAudioTrackId;
    let dataSlice = sparseTrack === undefined ? this.reader.requestSlice(dataStartPos, size) : null;
    if (dataSlice instanceof Promise) dataSlice = await dataSlice;
    const cluster = {'''
assert text.count(old) == 1
text = text.replace(old, new)
old = '''    this.currentCluster = cluster;
    if (dataSlice) {'''
new = '''    this.currentCluster = cluster;
    if (sparseTrack !== undefined) {
      await this.apexReadAudioCluster(dataStartPos, dataStartPos + size, sparseTrack);
    }
    if (dataSlice) {'''
assert text.count(old) == 1
text = text.replace(old, new)
method = Path(__file__).with_name('sparse-cluster.fragment.js').read_text()
anchor = '  getTrackDataInCluster(cluster, trackNumber) {'
assert text.count(anchor) == 1
text = text.replace(anchor, method + '\n' + anchor)
target = vendor / 'mediabunny-sparse.mjs'
target.write_text(text)
print(target, len(text.encode()), hashlib.sha256(text.encode()).hexdigest())
