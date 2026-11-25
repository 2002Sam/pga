from pga.__main__ import _raise_nofile_soft_limit


class FakeResource:
    RLIMIT_NOFILE = 7
    RLIM_INFINITY = -1

    def __init__(self, soft, hard, fail=False):
        self.limits = (soft, hard)
        self.calls = []
        self.fail = fail

    def getrlimit(self, _resource):
        return self.limits

    def setrlimit(self, resource, limits):
        self.calls.append((resource, limits))
        if self.fail:
            raise OSError("not permitted")
        self.limits = limits


def test_nofile_limit_raises_soft_to_4096_without_changing_hard():
    resource = FakeResource(256, 8192)

    assert _raise_nofile_soft_limit(resource)
    assert resource.limits == (4096, 8192)
    assert resource.calls == [(7, (4096, 8192))]


def test_nofile_limit_caps_at_hard_limit_and_never_lowers_existing_soft_limit():
    capped = FakeResource(256, 1024)
    assert _raise_nofile_soft_limit(capped)
    assert capped.limits == (1024, 1024)

    already_high = FakeResource(5000, 8192)
    assert not _raise_nofile_soft_limit(already_high)
    assert already_high.limits == (5000, 8192) and not already_high.calls


def test_nofile_limit_fails_closed_when_unsupported_or_not_permitted():
    unsupported = object()
    assert not _raise_nofile_soft_limit(unsupported)

    denied = FakeResource(256, 8192, fail=True)
    assert not _raise_nofile_soft_limit(denied)
    assert denied.limits == (256, 8192)


def test_unlimited_soft_limit_is_not_reduced():
    unlimited = FakeResource(-1, -1)
    assert not _raise_nofile_soft_limit(unlimited)
    assert unlimited.limits == (-1, -1) and not unlimited.calls
