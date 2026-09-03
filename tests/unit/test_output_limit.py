import pytest
from dsh_capsule.capsule.docker_backend import MAX_RESPONSE_BYTES, enforce_response_limit
def test_within_limit_passes():
    # 作用：上限内（含空响应）的响应放行
    enforce_response_limit(b"")
    enforce_response_limit(b"x" * MAX_RESPONSE_BYTES)
def test_over_limit_rejected():
    # 作用：超过 2MB 上限的响应被拒（Fail Closed）
    with pytest.raises(RuntimeError, match="CAPSULE_OUTPUT_TOO_LARGE"):
        enforce_response_limit(b"x" * (MAX_RESPONSE_BYTES + 1))
def test_none_rejected():
    # 作用：缺失响应视为违规（Fail Closed）
    with pytest.raises(RuntimeError, match="CAPSULE_OUTPUT_TOO_LARGE"):
        enforce_response_limit(None)
