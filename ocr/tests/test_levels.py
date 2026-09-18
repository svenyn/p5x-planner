"""Covers the level template store.

The measurements this design rests on are in levels.py: two captures of the
same level are 0 pixels apart, two different levels 365, and the same card via
Steam versus a live screen grab 9. What is tested here is that the accept and
margin rules turn those distances into the right verdicts — in particular that
a level with no template comes back *unknown* rather than being rounded into
the nearest level that does have one, which is the failure that would silently
corrupt an inventory.
"""
import numpy as np
import pytest
from PIL import Image

from levels import ACCEPT_MAX, MARGIN, LevelTemplates

SHAPE = (69, 101)


def render(seed, ink=400):
    """A distinct synthetic 'render'. Deterministic, so the same seed is the
    same level and different seeds are far apart."""
    rng = np.random.RandomState(seed)
    a = np.zeros(SHAPE, bool)
    idx = rng.choice(a.size, ink, replace=False)
    a.ravel()[idx] = True
    return a


def as_crop(bits):
    return Image.fromarray((bits * 255).astype(np.uint8))


def noisy(bits, n, seed=99):
    """The same render with n pixels flipped — capture-method noise."""
    rng = np.random.RandomState(seed)
    out = bits.copy()
    for i in rng.choice(out.size, n, replace=False):
        out.ravel()[i] = ~out.ravel()[i]
    return out


@pytest.fixture
def store():
    t = LevelTemplates()
    t.learn(as_crop(render(1)), 0)
    t.learn(as_crop(render(2)), 25)
    return t


def test_an_exact_render_is_recognised(store):
    lv, dist, why = store.classify(as_crop(render(1)))
    assert (lv, dist, why) == (0, 0, None)


def test_capture_noise_is_tolerated(store):
    # 9 pixels is what Steam-vs-live actually differed by on a real card.
    lv, dist, why = store.classify(as_crop(noisy(render(2), 9)))
    assert lv == 25
    assert dist == 9
    assert why is None


def test_a_level_with_no_template_comes_back_unknown(store):
    # The corruption case: it must not be rounded to whichever known level
    # happens to be nearest.
    lv, dist, why = store.classify(as_crop(render(7)))
    assert lv is None
    assert dist > ACCEPT_MAX
    assert "past the" in why


def test_a_render_just_past_the_limit_is_refused(store):
    lv, _, why = store.classify(as_crop(noisy(render(1), ACCEPT_MAX + 5)))
    assert lv is None and why


def test_two_templates_too_close_together_are_refused():
    # A store holding two nearly-identical renders must decline rather than
    # decide by a couple of pixels.
    t = LevelTemplates()
    base = render(3)
    t.learn(as_crop(base), 12)
    t.learn(as_crop(noisy(base, 4, seed=5)), 14)
    lv, _, why = t.classify(as_crop(base))
    assert lv is None
    assert "too close to call" in why


def test_an_empty_store_recognises_nothing():
    lv, dist, why = LevelTemplates().classify(as_crop(render(1)))
    assert (lv, dist) == (None, None)
    assert "no level templates" in why


def test_a_differently_sized_crop_is_refused_not_guessed(store):
    # Recalibrating the level box or changing resolution invalidates the
    # templates; comparing across shapes would be nonsense.
    small = Image.fromarray(np.zeros((20, 30), np.uint8))
    assert not store.usable_for(small)
    lv, _, why = store.classify(small)
    assert lv is None
    assert "built for" in why


def test_usable_for_is_false_on_an_empty_store():
    assert not LevelTemplates().usable_for(as_crop(render(1)))


def test_learning_a_new_render_of_a_known_level_replaces_it(store):
    assert store.learn(as_crop(noisy(render(1), 20)), 0) is True
    assert store.learn(as_crop(noisy(render(1), 20)), 0) is False   # same again
    assert store.classify(as_crop(noisy(render(1), 20)))[0] == 0


def test_learning_refuses_a_crop_of_the_wrong_shape(store):
    with pytest.raises(ValueError):
        store.learn(Image.fromarray(np.zeros((10, 10), np.uint8)), 5)


def test_a_round_trip_through_disk_preserves_every_template(store, tmp_path):
    path = store.save(tmp_path / "lv.json")
    back = LevelTemplates.load(path)
    assert back.shape == store.shape
    assert back.known == store.known == [0, 25]
    for lv in store.known:
        assert np.array_equal(back.templates[lv], store.templates[lv])
    assert back.classify(as_crop(render(1)))[0] == 0


def test_loading_a_missing_file_gives_an_empty_store(tmp_path):
    t = LevelTemplates.load(tmp_path / "nope.json")
    assert len(t) == 0 and t.shape is None


def test_saving_an_empty_store_is_refused(tmp_path):
    with pytest.raises(ValueError):
        LevelTemplates().save(tmp_path / "lv.json")


def test_the_shipped_templates_load_and_are_mutually_distinct():
    """The real config/level_templates.json, if it has been built."""
    t = LevelTemplates.load()
    if not len(t):
        pytest.skip("level templates not built on this machine")
    assert 0 in t.known, "level 0 is the bulk of any inventory and must be present"
    for i, a in enumerate(t.known):
        for b in t.known[i + 1:]:
            d = int(np.count_nonzero(t.templates[a] ^ t.templates[b]))
            # Two conditions, and both matter. Past 2*ACCEPT_MAX a render of one
            # cannot be *closer* to the other however noisy the capture, so a
            # misread is impossible. Past ACCEPT_MAX+MARGIN a clean capture of
            # one still clears the runner-up test, so it is not merely refused.
            assert d > 2 * ACCEPT_MAX, (
                f"levels {a} and {b} are {d}px apart; under {2 * ACCEPT_MAX} a noisy "
                f"capture of one could be read as the other")
            assert d > ACCEPT_MAX + MARGIN, (
                f"levels {a} and {b} are {d}px apart; under {ACCEPT_MAX + MARGIN} a "
                f"clean capture of one gets refused as too close to call")
