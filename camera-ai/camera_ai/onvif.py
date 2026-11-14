"""Minimal ONVIF client for pan / tilt cameras: SOAP 1.2 with a WS-Security UsernameToken digest.

Covers what the Tapo C500 needs: service URLs, media profile, ContinuousMove, RelativeMove, Stop,
presets (list / go / set / remove) and the PTZ status. No external dependencies except requests.
"""
import base64
import hashlib
import os
import re
import time
from datetime import datetime, timezone
from xml.etree import ElementTree as ET

import requests

NS = {
    "s": "http://www.w3.org/2003/05/soap-envelope",
    "tds": "http://www.onvif.org/ver10/device/wsdl",
    "trt": "http://www.onvif.org/ver10/media/wsdl",
    "tptz": "http://www.onvif.org/ver20/ptz/wsdl",
    "tt": "http://www.onvif.org/ver10/schema",
}


class OnvifError(RuntimeError):
    pass


class Onvif:
    def __init__(self, host: str, port: int, user: str, password: str, timeout: float = 8.0):
        self.device_url = f"http://{host}:{port}/onvif/device_service"
        self.user, self.password, self.timeout = user, password, timeout
        self.http = requests.Session()
        self.media_url = self.ptz_url = None
        self.profile = None
        self.clock_offset = 0.0  # camera time - PC time, seconds

    # --- SOAP -----------------------------------------------------------------
    def _security(self) -> str:
        nonce = os.urandom(16)
        created = datetime.fromtimestamp(time.time() + self.clock_offset, timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.000Z")
        digest = base64.b64encode(hashlib.sha1(nonce + created.encode() + self.password.encode()).digest()).decode()
        return (
            '<wsse:Security s:mustUnderstand="1" '
            'xmlns:wsse="http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-wssecurity-secext-1.0.xsd" '
            'xmlns:wsu="http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-wssecurity-utility-1.0.xsd">'
            f"<wsse:UsernameToken><wsse:Username>{_esc(self.user)}</wsse:Username>"
            '<wsse:Password Type="http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-username-token-profile-1.0#PasswordDigest">'
            f"{digest}</wsse:Password>"
            '<wsse:Nonce EncodingType="http://docs.oasis-open.org/wss/2004/01/oasis-200401-soap-message-security-1.0#Base64Binary">'
            f"{base64.b64encode(nonce).decode()}</wsse:Nonce><wsu:Created>{created}</wsu:Created>"
            "</wsse:UsernameToken></wsse:Security>"
        )

    def call(self, url: str, body: str, auth: bool = True) -> ET.Element:
        env = (
            '<?xml version="1.0" encoding="UTF-8"?>'
            '<s:Envelope xmlns:s="http://www.w3.org/2003/05/soap-envelope" '
            'xmlns:tds="http://www.onvif.org/ver10/device/wsdl" xmlns:trt="http://www.onvif.org/ver10/media/wsdl" '
            'xmlns:tptz="http://www.onvif.org/ver20/ptz/wsdl" xmlns:tt="http://www.onvif.org/ver10/schema">'
            f"<s:Header>{self._security() if auth else ''}</s:Header><s:Body>{body}</s:Body></s:Envelope>"
        )
        r = self.http.post(url, data=env.encode(), timeout=self.timeout,
                           headers={"Content-Type": "application/soap+xml; charset=utf-8"})
        root = ET.fromstring(r.content)
        fault = root.find(".//s:Fault", NS)
        if fault is not None:
            text = " ".join(t.strip() for t in fault.itertext() if t.strip())
            raise OnvifError(f"HTTP {r.status_code}: {text[:300]}")
        return root.find("s:Body", NS)

    # --- setup ----------------------------------------------------------------
    def connect(self) -> "Onvif":
        """Clock sync (digest needs it), service URLs and the first media profile."""
        body = self.call(self.device_url, "<tds:GetSystemDateAndTime/>", auth=False)
        utc = body.find(".//tt:UTCDateTime", NS)
        if utc is not None:
            d, t = utc.find("tt:Date", NS), utc.find("tt:Time", NS)
            cam = datetime(int(d.findtext("tt:Year", namespaces=NS)), int(d.findtext("tt:Month", namespaces=NS)),
                           int(d.findtext("tt:Day", namespaces=NS)), int(t.findtext("tt:Hour", namespaces=NS)),
                           int(t.findtext("tt:Minute", namespaces=NS)), int(t.findtext("tt:Second", namespaces=NS)),
                           tzinfo=timezone.utc)
            self.clock_offset = cam.timestamp() - time.time()
        caps = self.call(self.device_url, "<tds:GetCapabilities><tds:Category>All</tds:Category></tds:GetCapabilities>")
        self.media_url = caps.findtext(".//tt:Media/tt:XAddr", namespaces=NS)
        self.ptz_url = caps.findtext(".//tt:PTZ/tt:XAddr", namespaces=NS)
        if not self.media_url or not self.ptz_url:
            raise OnvifError("camera reports no Media or PTZ service")
        profiles = self.call(self.media_url, "<trt:GetProfiles/>").findall(".//trt:Profiles", NS)
        if not profiles:
            raise OnvifError("no media profiles")
        self.profile = profiles[0].get("token")
        return self

    def device_info(self) -> dict:
        b = self.call(self.device_url, "<tds:GetDeviceInformation/>")
        r = b.find("tds:GetDeviceInformationResponse", NS)
        return {c.tag.split("}")[1]: c.text for c in r} if r is not None else {}

    # --- PTZ ------------------------------------------------------------------
    def continuous_move(self, pan: float, tilt: float) -> None:
        """pan / tilt velocity in -1..1 (pan > 0 right, tilt > 0 up). Moves until stop()."""
        self.call(self.ptz_url,
                  f"<tptz:ContinuousMove><tptz:ProfileToken>{self.profile}</tptz:ProfileToken>"
                  f'<tptz:Velocity><tt:PanTilt x="{_clip(pan)}" y="{_clip(tilt)}"/></tptz:Velocity></tptz:ContinuousMove>')

    def stop(self) -> None:
        self.call(self.ptz_url,
                  f"<tptz:Stop><tptz:ProfileToken>{self.profile}</tptz:ProfileToken>"
                  "<tptz:PanTilt>true</tptz:PanTilt><tptz:Zoom>true</tptz:Zoom></tptz:Stop>")

    def relative_move(self, pan: float, tilt: float) -> None:
        """Step in the camera's translation space (-1..1 is the full range)."""
        self.call(self.ptz_url,
                  f"<tptz:RelativeMove><tptz:ProfileToken>{self.profile}</tptz:ProfileToken>"
                  f'<tptz:Translation><tt:PanTilt x="{_clip(pan)}" y="{_clip(tilt)}"/></tptz:Translation></tptz:RelativeMove>')

    def move_for(self, pan: float, tilt: float, seconds: float) -> None:
        """ContinuousMove for a time, then Stop (works on cameras without RelativeMove)."""
        self.continuous_move(pan, tilt)
        try:
            time.sleep(max(0.05, min(seconds, 5.0)))
        finally:
            self.stop()

    def presets(self) -> list[dict]:
        b = self.call(self.ptz_url, f"<tptz:GetPresets><tptz:ProfileToken>{self.profile}</tptz:ProfileToken></tptz:GetPresets>")
        return [{"token": p.get("token"), "name": p.findtext("tt:Name", namespaces=NS) or p.get("token")}
                for p in b.findall(".//tptz:Preset", NS)]

    def goto_preset(self, token: str) -> None:
        self.call(self.ptz_url,
                  f"<tptz:GotoPreset><tptz:ProfileToken>{self.profile}</tptz:ProfileToken>"
                  f"<tptz:PresetToken>{_esc(token)}</tptz:PresetToken></tptz:GotoPreset>")

    def set_preset(self, name: str) -> str:
        b = self.call(self.ptz_url,
                      f"<tptz:SetPreset><tptz:ProfileToken>{self.profile}</tptz:ProfileToken>"
                      f"<tptz:PresetName>{_esc(name)}</tptz:PresetName></tptz:SetPreset>")
        return b.findtext(".//tptz:PresetToken", namespaces=NS) or ""

    def remove_preset(self, token: str) -> None:
        self.call(self.ptz_url,
                  f"<tptz:RemovePreset><tptz:ProfileToken>{self.profile}</tptz:ProfileToken>"
                  f"<tptz:PresetToken>{_esc(token)}</tptz:PresetToken></tptz:RemovePreset>")

    def status(self) -> dict:
        b = self.call(self.ptz_url, f"<tptz:GetStatus><tptz:ProfileToken>{self.profile}</tptz:ProfileToken></tptz:GetStatus>")
        pt = b.find(".//tt:Position/tt:PanTilt", NS)
        move = b.findtext(".//tt:MoveStatus/tt:PanTilt", namespaces=NS)
        return {"pan": float(pt.get("x")) if pt is not None else None,
                "tilt": float(pt.get("y")) if pt is not None else None, "moving": move}


def _clip(v: float) -> str:
    return f"{max(-1.0, min(1.0, float(v))):.3f}"


def _esc(s: str) -> str:
    return re.sub(r"[<>&\"']", lambda m: {"<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;", "'": "&apos;"}[m.group()], str(s))
