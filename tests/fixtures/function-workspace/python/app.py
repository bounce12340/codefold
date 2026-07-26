from .helpers import normalize


class Formatter:
    def format(self, value: str) -> str:
        return normalize(value)

    def format_twice(self, value: str) -> str:
        return self.format(self.format(value))


def render(value: str) -> str:
    return normalize(value)
