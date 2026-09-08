class BrokerError(Exception):
    # 作用：统一携带规格第 28 节错误码的 Broker 异常；Fail Closed 下任意校验失败即抛出，且消息绝不包含 Secret
    def __init__(self, code: str, message: str = ""):
        super().__init__(f"{code}: {message}" if message else code)
        self.code = code
        self.message = message
