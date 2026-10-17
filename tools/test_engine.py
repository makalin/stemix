"""Regression checks for flat output names; no Demucs installation required."""

import runpy
import unittest
from pathlib import Path

engine = runpy.run_path(
    str(Path(__file__).resolve().parents[1] / "src-tauri/src/separate.py")
)
stem_path = engine["stem_path"]
JobProgress = engine["JobProgress"]


class FlatOutputTests(unittest.TestCase):
    def test_song_and_model_do_not_create_subfolders(self):
        output = Path("project/stems")
        result = stem_path(output, Path("K.Flay - Can't Sleep.wav"), "vocals", "wav")
        self.assertEqual(result.parent, output)
        self.assertEqual(result.name, "K.Flay - Can't Sleep - vocals.wav")

    def test_different_songs_have_different_stem_names(self):
        output = Path("project/stems")
        self.assertNotEqual(
            stem_path(output, Path("one.wav"), "vocals", "wav"),
            stem_path(output, Path("two.wav"), "vocals", "wav"),
        )


    def test_format_and_instrumental_names(self):
        self.assertEqual(
            stem_path(Path("custom"), Path("song.flac"), "no_vocals", "mp3"),
            Path("custom/song - no_vocals.mp3"),
        )


class OverallProgressTests(unittest.TestCase):
    def test_multiple_models_and_shifts_never_reset_or_finish_early(self):
        progress = JobProgress(2, [8] * 4, 100)
        values = []
        for model in range(4):
            for shift in range(2):
                for offset in [0, 600, 1200]:
                    for state in ["start", "end"]:
                        values.append(progress.update({
                            "model_idx_in_bag": model, "models": 4,
                            "shift_idx": shift, "audio_length": 1600,
                            "segment_offset": offset, "state": state,
                        }))
        self.assertEqual(values, sorted(values))
        self.assertLessEqual(max(values), 95)
        self.assertLess(values[5], 20)  # First of eight passes is not the whole job.
        self.assertEqual(values[-1], 95)

    def test_shift_padding_does_not_mark_a_pass_complete_early(self):
        progress = JobProgress(1, [8], 100)
        value = progress.update({
            "model_idx_in_bag": 0, "models": 1, "shift_idx": 0,
            "audio_length": 600, "segment_offset": 0, "state": "end",
        })
        self.assertLess(value, 95)

if __name__ == "__main__":
    unittest.main()
