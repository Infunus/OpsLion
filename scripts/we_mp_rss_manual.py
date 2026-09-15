"""Stop interactive native refreshes promptly when WeChat rejects collection."""
from urllib.parse import urlsplit


def configure_manual_refresh():
    from core import manual_refresh

    if getattr(manual_refresh.PageObserver, '_opslion_stop_on_rejection', False):
        return

    class InteractivePageObserver(manual_refresh.PageObserver):
        _opslion_stop_on_rejection = True

        def __call__(self, response, *args, **kwargs):
            result = super().__call__(response, *args, **kwargs)
            url = urlsplit(response.url)
            if self.error and url.hostname == 'mp.weixin.qq.com' and url.path in (
                '/cgi-bin/appmsgpublish', '/cgi-bin/appmsg'
            ):
                try:
                    code = response.json()['base_resp']['ret']
                except (ValueError, KeyError, TypeError):
                    return result
                if code in (200013, 200003):
                    # The upstream loop otherwise sleeps 60 + 120 seconds with
                    # no UI progress. The weekly workflow owns separate,
                    # cancellable retries; interactive refresh finishes here.
                    self.error += '；本次已停止'
                    raise manual_refresh.RefreshFailure(self.error)
            return result

    manual_refresh.PageObserver = InteractivePageObserver
