#!/usr/bin/env python3
"""Offline geometry and historical latency statistics; never opens the media file."""

import argparse
import hashlib
import json
from pathlib import Path


def merged(spans, gap=0):
    result = []
    for start, end in spans:
        if result and start <= result[-1][1] + gap:
            result[-1][1] = max(result[-1][1], end)
        else:
            result.append([start, end])
    return result


def percentile(ordered, fraction):
    if not ordered:
        return None
    position = (len(ordered) - 1) * fraction
    lower = int(position)
    upper = min(lower + 1, len(ordered) - 1)
    return ordered[lower] + (ordered[upper] - ordered[lower]) * (position - lower)


def analyze(path, variant):
    raw = path.read_bytes()
    trace = json.loads(raw)
    size = trace['size']
    spans = sorted((r['start'], r['end']) for r in trace['requests'])
    if any(not 0 <= start < end <= size for start, end in spans):
        raise ValueError('Trace contains invalid or out-of-bounds ranges')
    union = merged(spans)
    gaps = sorted(right[0] - left[1] for left, right in zip(union, union[1:]))
    curve = []
    for gap in [0, 4096, 16384, 32768, 65536, 131072, 196608, 262144, 524288, 1048576]:
        ranges = merged(union, gap)
        lengths = [end - start for start, end in ranges]
        curve.append({'gapBytes': gap, 'ranges': len(ranges), 'bytes': sum(lengths),
                      'maxRangeBytes': max(lengths, default=0), 'sourceFraction': sum(lengths) / size})
    pages = []
    for page in [4096, 16384, 65536, 262144, 1048576, 4194304]:
        # Use page intervals rather than allocating a set proportional to file size.
        page_ranges = merged([(start // page, (end + page - 1) // page) for start, end in union])
        count = sum(end - start for start, end in page_ranges)
        covered = sum(min(size, end * page) - start * page for start, end in page_ranges)
        pages.append({'pageBytes': page, 'uniquePages': count, 'bytes': covered})
    groups = [
        ('all', lambda n: True),
        ('up_to_4KiB', lambda n: n <= 4096),
        ('4KiB_to_64KiB', lambda n: 4096 < n <= 65536),
        ('above_64KiB', lambda n: n > 65536),
    ]
    latencies = []
    for name, include in groups:
        reads = [r for r in trace['reads'] if include(r['end'] - r['start'])]
        timings = sorted(r['ms'] for r in reads)
        total = sum(r['ms'] for r in reads)
        latencies.append({
            'group': name, 'count': len(reads), 'bytes': sum(r['end'] - r['start'] for r in reads),
            'sumReadMs': total, 'meanMs': total / len(reads) if reads else None,
            'p50Ms': percentile(timings, .5), 'p90Ms': percentile(timings, .9),
            'p99Ms': percentile(timings, .99),
            'greater1ms': sum(t > 1 for t in timings), 'greater5ms': sum(t > 5 for t in timings),
        })
    return {
        'analysisVersion': 1, 'percentileMethod': 'linear interpolation at (n - 1) * p',
        'sourceTrace': str(path.resolve()), 'sourceTraceSHA256': hashlib.sha256(raw).hexdigest(),
        'sourceTraceBytes': len(raw), 'sourceFileBytes': size, 'traceVariant': variant,
        'logicalRequestCount': len(spans), 'requiredUnionRanges': len(union),
        'requiredUnionBytes': sum(end - start for start, end in union),
        'gapPercentilesBytes': {str(p): percentile(gaps, p) for p in [.1, .25, .5, .75, .9, .99]},
        'omniscientCoalescingCurve': curve, 'alignedPageCoverage': pages,
        'priorTraceReadLatencyDistribution': latencies,
        'notes': [
            'OFFLINE analysis only; this program never opens the media file or performs a benchmark.',
            'Future ranges are assumed known. This is not an implementable online algorithm or timing result.',
            'Large coalesced ranges can exceed bounded memory limits and must be streamed or split.',
            'Logical requests, source range reads, stream chunks, filesystem calls, and physical disk I/O differ.',
            'Historical latency includes buffer allocation and the async read elapsed time, plus OS cache effects.',
            'Read size groups are observational, not randomized treatments; do not infer causality from their means.',
        ],
    }


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('trace', type=Path)
    parser.add_argument('output', type=Path)
    parser.add_argument('--variant', required=True, help='Describe the exact historical reader variant')
    args = parser.parse_args()
    if args.trace.resolve() == args.output.resolve():
        parser.error('Output must not overwrite the input trace')
    report = analyze(args.trace, args.variant)
    args.output.write_text(json.dumps(report, ensure_ascii=False, indent=2) + '\n')
    print(json.dumps({'output': str(args.output.resolve()), 'sourceSHA256': report['sourceTraceSHA256'],
                      'requiredRanges': report['requiredUnionRanges'], 'requiredBytes': report['requiredUnionBytes']}))
