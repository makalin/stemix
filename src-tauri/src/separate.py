"""Use the existing Demucs engine, saving stems directly in the selected folder."""

from pathlib import Path
import json


def report(message, progress=None):
    print("STEMIX_EVENT " + json.dumps({
        "kind": "progress", "message": message, "progress": progress
    }), flush=True)


class JobProgress:
    """Aggregate model/shift passes; reserve the last five percent for file writes."""

    def __init__(self, shifts, segments, samplerate, overlap=0.25):
        self.shifts = max(1, shifts)
        self.segments = segments
        self.samplerate = samplerate
        self.overlap = overlap
        self.last = 5.0

    def update(self, info):
        model = info["model_idx_in_bag"]
        stride = max(1, int((1 - self.overlap) * int(self.segments[model] * self.samplerate)))
        # Demucs pads shifted audio by up to half a second. Using that upper bound
        # avoids claiming a pass is finished before its final chunk has run.
        length = max(1, info["audio_length"] + self.samplerate // 2)
        completed = info["segment_offset"] + (stride if info["state"] == "end" else 0)
        fraction = min(1.0, completed / length)
        passes = max(1, info["models"]) * self.shifts
        position = model * self.shifts + info["shift_idx"] + fraction
        self.last = max(self.last, min(95.0, 5 + 90 * position / passes))
        return self.last


def stem_path(output: Path, track: Path, stem: str, extension: str) -> Path:
    return output / f"{track.stem} - {stem}.{extension}"


def main():
    from demucs.api import Separator, save_audio
    from demucs.separate import get_parser

    args = get_parser().parse_args()
    if len(args.tracks) != 1:
        raise ValueError("Stemix expects exactly one source audio file")
    track = args.tracks[0]
    report("Loading Demucs model…", 0)
    separator = Separator(
        model=args.name,
        device=args.device,
        shifts=args.shifts,
        progress=False,
    )
    models = getattr(separator.model, "models", [separator.model])
    progress = JobProgress(args.shifts, [model.segment for model in models], separator.samplerate)

    def on_chunk(info):
        percentage = progress.update(info)
        report(
            f"Separating · model {info['model_idx_in_bag'] + 1}/{info['models']}"
            f" · shift {info['shift_idx'] + 1}/{args.shifts}",
            percentage,
        )

    separator.update_parameter(callback=on_chunk)
    report("Reading source audio…", 2)
    print(f"Saving stems directly to {args.out}", flush=True)
    _, sources = separator.separate_audio_file(track)
    if args.stem is not None:
        selected = sources[args.stem]
        instrumental = sum(source for name, source in sources.items() if name != args.stem)
        sources = {args.stem: selected, f"no_{args.stem}": instrumental}
    extension = "mp3" if args.mp3 else "wav"
    args.out.mkdir(parents=True, exist_ok=True)
    report("Saving stem files…", 95)
    for index, (name, audio) in enumerate(sources.items()):
        destination = stem_path(args.out, track, name, extension)
        save_audio(
            audio,
            str(destination),
            samplerate=separator.samplerate,
            bitrate=args.mp3_bitrate,
            preset=args.mp3_preset,
            clip=args.clip_mode,
            as_float=args.float32,
            bits_per_sample=24 if args.int24 else 16,
        )
        print(f"Saved: {destination}", flush=True)
        report(f"Saved {index + 1}/{len(sources)} stem files", 95 + 4 * (index + 1) / len(sources))


if __name__ == "__main__":
    main()
