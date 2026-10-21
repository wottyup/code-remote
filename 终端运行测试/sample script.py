from pathlib import Path

print("script_type=python")
print(f"script_path={Path(__file__).resolve()}")
print(f"working_directory={Path.cwd()}")
print("status=ok")
