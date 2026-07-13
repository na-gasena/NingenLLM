"""
title: Human Shell Command
author: ningenllm
description: humanllm経由で「人間」が指示したシェルコマンドを、Open WebUIのバックエンド(=operatorと同じPC)でローカル実行する
version: 0.1.0
"""

import subprocess


class Tools:
    def __init__(self):
        pass

    def shell_command(self, command: str, workdir: str = "") -> str:
        """
        シェルコマンドをローカルPC上で実行し、標準出力・標準エラー・終了コードを返す。
        :param command: 実行するシェルコマンド文字列
        :param workdir: 実行時のカレントディレクトリ（省略可）
        :return: 実行結果（exit_code / stdout / stderr）
        """
        try:
            result = subprocess.run(
                command,
                shell=True,
                cwd=workdir or None,
                capture_output=True,
                text=True,
                timeout=30,
            )
            return (
                f"exit_code: {result.returncode}\n"
                f"stdout:\n{result.stdout}\n"
                f"stderr:\n{result.stderr}"
            )
        except Exception as e:
            return f"Error running command: {e}"
