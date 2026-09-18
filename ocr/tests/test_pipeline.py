"""End-to-end test using a directory of synthetic panel images as the
"source", the same PIL-rendered stand-in test_panel_ocr.py uses in place of
real screenshots."""
import json

from calibrate import save_config
from pipeline import run_pipeline, unique_out_path
from tests.test_panel_ocr import _build_panel


def _write_sample_frames(tmp_path):
    """Two clean Star-slot cards and one deliberately broken one (unresolvable
    set name), all sharing one region layout — realistic, since your device's
    UI layout doesn't change between cards, and all in one slot — realistic,
    since the game's own tabs already sort cards by slot, so a real scanning
    batch would be one slot at a time too (see pipeline.py's --slot)."""
    frames_dir = tmp_path / "frames"
    frames_dir.mkdir()
    regions = None

    img, regions = _build_panel(
        title="[Futility]", level_text="Lv.25", main_label="Crit Rate",
        subs=[("Damage Mult.+", "2.1%"), ("HP", "2.9%"), ("Defense", "4.1%"), ("Pierce Rate", "3.9%")],
    )
    img.save(frames_dir / "001.png")

    img2, _ = _build_panel(
        title="[Opulence]", level_text="Lv.20", main_label="Crit Multiplier",
        subs=[("Damage Mult.+", "3.1%"), ("Speed", "2.5"), ("SP Recovery", "11.2%"),
              ("Defense", "4.6%")],
    )
    img2.save(frames_dir / "002.png")

    img3, _ = _build_panel(
        title="[Not A Real Set At All]", level_text="Lv.5", main_label="Crit Rate",
        subs=[("Damage Mult.+", "2.1%")],
    )
    img3.save(frames_dir / "003.png")

    regions_path = tmp_path / "crop_regions.json"
    save_config(regions, img.size, regions_path)
    return frames_dir, regions_path


def test_pipeline_splits_clean_and_broken_cards(tmp_path):
    frames_dir, regions_path = _write_sample_frames(tmp_path)
    valid, invalid, out_path, review_path = run_pipeline(
        frames_dir, regions_path, tmp_path / "cards.json", rarity=5, slot="Star",
    )

    assert len(valid) == 2
    assert len(invalid) == 1
    assert invalid[0]["src"] == "003.png"
    assert any("could not resolve set" in e for e in invalid[0]["errors"] + invalid[0]["notes"])

    with open(out_path) as f:
        written = json.load(f)
    assert written == {"cards": valid}
    assert {c["set"] for c in valid} == {"Futility", "Opulence"}
    assert all(c["slot"] == "Star" for c in valid)

    with open(review_path) as f:
        assert json.load(f) == invalid


def test_pipeline_does_not_write_a_review_file_when_nothing_is_flagged(tmp_path):
    frames_dir, regions_path = _write_sample_frames(tmp_path)
    (frames_dir / "003.png").unlink()  # drop the deliberately-broken frame

    valid, invalid, out_path, review_path = run_pipeline(
        frames_dir, regions_path, tmp_path / "cards.json", rarity=5, slot="Star",
    )

    assert len(invalid) == 0
    # review_path is still handed back for messaging, but nothing on disk —
    # an empty "[]" file was a standing invitation to review nothing.
    assert not review_path.exists()


def test_pipeline_without_rarity_sends_everything_to_review(tmp_path):
    frames_dir, regions_path = _write_sample_frames(tmp_path)
    valid, invalid, _, _ = run_pipeline(frames_dir, regions_path, tmp_path / "cards.json", rarity=None, slot="Star")

    # rarity isn't visible on the panel, so nothing should be accepted as
    # clean without a human (or a batching convention) supplying it
    assert len(valid) == 0
    assert len(invalid) == 3


def test_pipeline_without_slot_sends_heavens_cards_to_review(tmp_path):
    frames_dir, regions_path = _write_sample_frames(tmp_path)
    valid, invalid, _, _ = run_pipeline(frames_dir, regions_path, tmp_path / "cards.json", rarity=5, slot=None)

    # slot isn't visible on the panel either, so a Heavens set with no slot
    # given must not be silently guessed
    assert len(valid) == 0
    assert len(invalid) == 3


def test_second_batch_to_the_same_out_path_does_not_overwrite_the_first(tmp_path):
    frames_dir, regions_path = _write_sample_frames(tmp_path)
    out_path = tmp_path / "cards.json"

    _, _, out_path_1, review_path_1 = run_pipeline(frames_dir, regions_path, out_path, rarity=5, slot="Star")
    _, _, out_path_2, review_path_2 = run_pipeline(frames_dir, regions_path, out_path, rarity=5, slot="Star")

    assert out_path_1 == tmp_path / "cards.json"
    assert out_path_2 == tmp_path / "cards-2.json"
    assert review_path_1 == tmp_path / "cards-review.json"
    assert review_path_2 == tmp_path / "cards-2-review.json"
    # the first batch's files must still exist, unmodified in location
    assert out_path_1.exists()
    assert review_path_1.exists()


def test_unique_out_path_keeps_incrementing_past_existing_numbered_files(tmp_path):
    (tmp_path / "cards.json").write_text("{}")
    (tmp_path / "cards-2.json").write_text("{}")
    assert unique_out_path(tmp_path / "cards.json") == tmp_path / "cards-3.json"
