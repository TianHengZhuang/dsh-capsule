from pathlib import Path
import pytest
from dsh_capsule.capsule.manifest import load_manifest
REPO_ROOT = Path(__file__).resolve().parents[2]
HELLO_MANIFEST = REPO_ROOT / "capsules" / "hello" / "capsule.yaml"
def _write(tmp_path: Path, content: str) -> Path:
    # 作用：写入临时 capsule.yaml 供负向用例使用
    capsule_dir = tmp_path / "demo"
    capsule_dir.mkdir()
    p = capsule_dir / "capsule.yaml"
    p.write_text(content, encoding="utf-8")
    return p
def test_valid_hello_manifest():
    # 作用：验证仓库内置 hello capsule 能通过严格校验
    m = load_manifest(HELLO_MANIFEST)
    assert m.metadata.id == "hello"
    assert m.runtime.image == "dsh-capsule/hello:0.1.0"
    assert [t.name for t in m.tools] == ["hello_capsule"]
    assert m.credentials == []
def test_wrong_api_version_rejected(tmp_path):
    # 作用：apiVersion 不符必须拒绝（Fail Closed）
    p = _write(tmp_path, "apiVersion: other/v1\nkind: Capsule\nmetadata: {id: x, version: 0.1.0}\nruntime: {image: img, command: [python]}\n")
    with pytest.raises(Exception):
        load_manifest(p)
def test_missing_image_rejected(tmp_path):
    # 作用：缺少镜像声明必须拒绝
    p = _write(tmp_path, "apiVersion: dsh-capsule/v1\nkind: Capsule\nmetadata: {id: x, version: 0.1.0}\nruntime: {command: [python]}\n")
    with pytest.raises(Exception):
        load_manifest(p)
def test_unknown_field_rejected(tmp_path):
    # 作用：未知字段（如误填真实凭据的任意键）必须拒绝
    p = _write(tmp_path, "apiVersion: dsh-capsule/v1\nkind: Capsule\nmetadata: {id: x, version: 0.1.0}\nruntime: {image: img, command: [python]}\npassword: hunter2\n")
    with pytest.raises(Exception):
        load_manifest(p)
def test_not_a_mapping_rejected(tmp_path):
    # 作用：非映射结构的 manifest 必须拒绝
    p = tmp_path / "capsule.yaml"
    p.write_text("- a\n- b\n", encoding="utf-8")
    with pytest.raises(Exception):
        load_manifest(p)
