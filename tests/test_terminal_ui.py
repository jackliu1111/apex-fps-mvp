import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch
from prompt_toolkit.input import create_pipe_input
from prompt_toolkit.output import DummyOutput
from prompt_toolkit.data_structures import Size
import highlight_cli as cli
import terminal_ui as ui


class TerminalOutput(DummyOutput):
    def __init__(self, columns=80, rows=24):
        self.size = Size(rows=rows, columns=columns)

    def get_size(self):
        return self.size

    def get_rows_below_cursor_position(self):
        return self.size.rows


class TerminalTests(unittest.TestCase):
    def setUp(self):
        self.data = {'input': '/tmp/录像.mp4', 'clips': [
            {'start': i*2., 'end': i*2.+1., 'event_count': 2} for i in range(30)]}

    def run_review(self, state, keys, **kwargs):
        with create_pipe_input() as pipe:
            app = ui.review_app(self.data, state, input=pipe, output=TerminalOutput(), **kwargs)
            return app.run(pre_run=lambda: pipe.send_text(keys))

    def test_selection_survives_preview_and_reentry(self):
        state = ui.ReviewState(set(range(1, 31)))
        self.assertEqual('preview', self.run_review(state, ' \x1b[B p', preview=True))
        self.assertEqual(1, state.cursor)
        self.assertNotIn(1, state.selected)
        self.assertNotIn(2, state.selected)
        self.assertEqual('export', self.run_review(state, 'e'))
        self.assertEqual(set(range(3, 31)), state.selected)

    def test_all_toggle_empty_export_and_readonly(self):
        state = ui.ReviewState({1})
        self.assertEqual('back', self.run_review(state, 'aae\x1b'))
        self.assertEqual(set(), state.selected)
        self.assertEqual('back', self.run_review(state, ' ae\x1b', eligible=False))
        self.assertEqual(set(), state.selected)

    def test_resize_keeps_focused_candidate_visible(self):
        for columns, rows in [(80, 24), (80, 32), (120, 40), (40, 16)]:
            with self.subTest(columns=columns, rows=rows), create_pipe_input() as pipe:
                state = ui.ReviewState({30}, cursor=29)
                output = TerminalOutput(columns, rows)
                app = ui.review_app(self.data, state, input=pipe, output=output,
                                    preview=True, curve=True)
                observed = []
                def rendered(sender):
                    if sender.is_done:
                        return
                    window = sender.layout.current_window
                    info = window.render_info
                    observed.append(info)
                    if len(observed) == 1:
                        output.size = Size(rows=rows+2, columns=columns)
                        sender.invalidate()
                    else:
                        sender.exit(result='back')
                app.after_render += rendered
                app.run()
                self.assertEqual(2, len(observed))
                for info in observed:
                    self.assertGreater(info.window_height, 0)
                    self.assertIn(29, info.displayed_lines)
                    self.assertLess(info.cursor_position.y, info.window_height)

    def test_pause_none_is_normal_but_regular_prompt_none_cancels(self):
        with patch.object(cli.q, 'press_any_key_to_continue') as prompt:
            prompt.return_value.unsafe_ask.return_value = None
            cli.pause()
            with self.assertRaises(KeyboardInterrupt):
                cli.ask(prompt.return_value)

    def test_paths_and_parameter_edit_validation(self):
        with tempfile.TemporaryDirectory() as folder:
            source = Path(folder) / '录像.mp4'
            source.touch()
            self.assertIs(True, cli.path_validation(f'"{source}"'))
            self.assertIsNot(True, cli.path_validation(str(source/'missing')))
            self.assertIsNot(True, cli.path_validation(str(source), directory=True))
            params = cli.service.Parameters(mode='damage')
            calls = iter(['damage_fps', '60', 'done'])
            def ask(prompt):
                answer = next(calls)
                if answer == '60':
                    validator = prompt.application.current_buffer.validator
                    from prompt_toolkit.document import Document
                    from prompt_toolkit.validation import ValidationError
                    with self.assertRaises(ValidationError):
                        validator.validate(Document('99'))
                    validator.validate(Document(answer))
                return answer
            with patch.object(cli, 'ask', side_effect=ask), patch.object(cli, 'screen'):
                cli.edit_parameters(params, source)
            self.assertEqual(60, params.damage_fps)

    def test_cancel_export_preserves_ids_and_does_not_render(self):
        data = dict(self.data, format_version=cli.service.VERSION, source={'size': 1})
        with tempfile.TemporaryDirectory() as folder:
            result = Path(folder)/'clips.json'
            source = Path(folder)/'source.mp4'
            source.touch()
            data['input'] = str(source)
            selected = [2, 4]
            with patch.object(cli.service, 'load_result', return_value=data), \
                 patch.object(cli, 'screen'), patch.object(cli.ui, 'context'), \
                 patch.object(cli, 'ask', return_value=False), patch.object(cli, 'do_export') as export:
                cli.wizard_export(result, ids=selected)
            export.assert_not_called()
            self.assertEqual([2, 4], selected)


if __name__ == '__main__':
    unittest.main()
