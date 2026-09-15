import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
import numpy as np

import damage_detector as damage
import highlight_service as service
from highlight_cli import app
from typer.testing import CliRunner


class DamageTests(unittest.TestCase):
    def test_source_hud_digits_and_non_damage_background(self):
        with np.load(Path(__file__).parent/'data/damage_hud.npz') as fixture:
            for frame,value in zip(fixture['frames'],fixture['expected']):
                self.assertEqual(None if value<0 else int(value),damage.read_counter(frame))

    def test_four_digits_do_not_truncate_to_three(self):
        frame=np.zeros((90,200,3),np.uint8)
        for i,n in enumerate([1,0,1,0]):
            mask=damage.BANKS['white_180'][n]
            frame[24:54,65+i*22:85+i*22]=mask[:,:,None]*255
        self.assertEqual(1010,damage.classify(frame,'white_180',damage.BANKS['white_180']))

    def test_baseline_unknown_reset_drop_and_short_transition(self):
        tracker=damage.CounterTracker()
        values=[160,160,None,170,170,10,10,20,20,25,30,30]
        found=[event for i,v in enumerate(values) if (event:=tracker.update(i/30,v))]
        self.assertEqual([(10,20),(20,30)],[(e['previous'],e['value']) for e in found])
        self.assertAlmostEqual(7/30,found[0]['time'],places=5)

    def test_merge_padding_clamp_and_no_duplicate_coverage(self):
        events=[{'time':t} for t in [.05,.35,.8]]
        clips=damage.make_clips(events,1.,gap=.3,before=.1,after=.2)
        self.assertEqual(2,len(clips))
        self.assertEqual(0,clips[0].start)
        self.assertAlmostEqual(.55,clips[0].end)
        self.assertEqual(1.,clips[1].end)
        self.assertEqual(2,clips[0].event_count)

    def test_damage_service_preview_is_separate_from_selection(self):
        with tempfile.TemporaryDirectory() as folder:
            root=Path(folder);src=root/'source.mkv';src.write_bytes(b'source')
            event={'time':1.,'previous':10,'value':20,'increase':10}
            clip=damage.make_clips([event],3.)
            with patch.object(service.core,'require_tools'),patch.object(service.core,'probe_media',return_value={'duration_seconds':3.}),\
                 patch.object(damage,'analyze_video',return_value=([event],clip,[],{'sampled_frames':90,'readable_frames':60})):
                result=service.analyze(src,root/'result',service.Parameters(mode='damage'))
            data=service.load_result(result)
            self.assertEqual('damage_counter_growth',data['config']['selection_signal'])
            self.assertEqual([],data['audio_curve'])
            def render(source,clips,output,work,progress,preview_ids):
                self.assertEqual([1],preview_ids)
                output.write_bytes(b'preview')
                return {'video_codec':'mpeg4'}
            with patch.object(service.precise_render,'render',side_effect=render):
                preview=service.export_result(result,preview=True)
            self.assertEqual('candidate_preview.mp4',preview.name)
            self.assertFalse((result.parent/'selection.json').exists())
            self.assertTrue((result.parent/'preview.json').exists())
            with self.assertRaises(ValueError):
                service.export_result(result,preview=True,output=src,overwrite=True)
            with self.assertRaises(FileExistsError):
                service.export_result(result,preview=True)
            output=CliRunner().invoke(app,['inspect',str(result)])
            self.assertEqual(0,output.exit_code,output.exception)
            self.assertIn('伤害计数增长',output.stdout)

    def test_invalid_damage_parameters(self):
        for params in [service.Parameters(mode='bad'),service.Parameters(damage_fps=0),
                       service.Parameters(damage_gap_s=-1)]:
            with self.assertRaises(ValueError):params.validate(Path('missing'))

if __name__=='__main__':unittest.main()
