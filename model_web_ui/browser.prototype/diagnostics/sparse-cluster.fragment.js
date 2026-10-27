  // Experimental audio-only Input. Reuse upstream block/lacing/timestamp parsing.
  async apexReadAudioCluster(start, end, trackId) {
    const headerAt = async (pos, limit) => {
      const slice = await this.reader.requestSliceRange(pos, MIN_HEADER_SIZE, Math.min(MAX_HEADER_SIZE, limit - pos));
      if (!slice) throw new Error('Truncated sparse MKV element');
      const header = readElementHeader(slice);
      if (!header || header.size === null || slice.filePos + header.size > limit) {
        throw new Error('Unsupported sparse MKV element boundary');
      }
      return { ...header, start: pos, data: slice.filePos, end: slice.filePos + header.size };
    };
    const blockTrack = async (element) => {
      const slice = await this.reader.requestSliceRange(element.data, 1, Math.min(8, element.size));
      if (!slice) throw new Error('Truncated sparse MKV block');
      return readVarInt(slice);
    };
    for (let pos = start; pos < end;) {
      const element = await headerAt(pos, end);
      let keep = element.id === 231; // Timestamp
      if (element.id === 163) keep = await blockTrack(element) === trackId;
      if (element.id === 160) { // Preserve the entire selected BlockGroup and its metadata.
        for (let childPos = element.data; childPos < element.end;) {
          const child = await headerAt(childPos, element.end);
          if (child.id === 161) { keep = await blockTrack(child) === trackId; break; }
          childPos = child.end;
        }
      }
      if (keep) {
        const slice = await this.reader.requestSlice(element.start, element.end - element.start);
        if (!slice) throw new Error('Truncated sparse MKV payload');
        this.traverseElement(slice);
      }
      pos = element.end;
    }
  }
