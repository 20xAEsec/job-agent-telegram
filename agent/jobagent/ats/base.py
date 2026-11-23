"""Adapter interface (DESIGN 12). A Field is a dict: {fid, label, type, required, options[], selector, section}."""


class Unexpected(Exception):
    """The page is not what the adapter expects (unknown control, failed navigation): a human must look."""


class Closed(Exception):
    """The posting is gone (404 or redirected to an error page)."""


class Adapter:
    name = ""

    @staticmethod
    def allowed_hosts(meta: dict) -> list[str]: raise NotImplementedError
    @staticmethod
    def apply_url(meta: dict) -> str: raise NotImplementedError
    def inspect(self, meta: dict) -> list[dict]: raise NotImplementedError          # -> fields.json
    def fill(self, page, plan_fields: list[dict], fields: dict, jdir) -> dict: raise NotImplementedError  # never submits
    def detect_blockers(self, page) -> str | None: raise NotImplementedError        # captcha | login | closed | None
    def submit(self, page, d, job_id: str) -> bool: raise NotImplementedError       # calls safety.click_submit
