# CAPTCHA native method reference

Companion to [CAPTCHA provider coverage](captcha-provider-coverage.md). Audited 2026-09-29. Generated from the executable catalog; 197 method variants across seven providers. Method IDs select an adapter contract, not an arbitrary upstream task type. Fixed values are added automatically. Fields use dot paths for nested objects; pass nested JSON, not literal dotted keys.

Required fields below are unconditional. GeeTest v3 additionally needs `gt` and a fresh `challenge`; v4 needs its provider-specific CAPTCHA ID. AWS WAF variants, proxy authentication, alternate image inputs, and VisionEngine module-specific fields have conditional requirements described in the guide and official documentation. Every submitted value must come from the selected challenge.

## capsolver (25 variants)

### GeeTestTaskProxyLess

Family: `geetest`. [Official contract](https://docs.capsolver.com/en/guide/captcha/Geetest/).

- Required: `websiteURL` (string).
- Optional: `gt` (string), `challenge` (string), `captchaId` (string), `riskType` (string), `geetestApiServerSubdomain` (string).
- Fixed wire values: `{"type":"GeeTestTaskProxyLess"}`.

### MtCaptchaTask

Family: `mtcaptcha`. [Official contract](https://docs.capsolver.com/en/guide/captcha/MtCaptcha/).

- Required: `websiteURL` (string), `websiteKey` (string), `proxy` (string).
- Optional: None.
- Fixed wire values: `{"type":"MtCaptchaTask"}`.

### MtCaptchaTaskProxyLess

Family: `mtcaptcha`. [Official contract](https://docs.capsolver.com/en/guide/captcha/MtCaptcha/).

- Required: `websiteURL` (string), `websiteKey` (string).
- Optional: `proxy` (string).
- Fixed wire values: `{"type":"MtCaptchaTaskProxyLess"}`.

### ReCaptchaV2TaskProxyLess

Family: `recaptcha_v2`. [Official contract](https://docs.capsolver.com/en/guide/captcha/ReCaptchaV2/).

- Required: `websiteURL` (string), `websiteKey` (string).
- Optional: `cookies` (array), `proxy` (string), `pageAction` (string), `recaptchaDataSValue` (string), `enterprisePayload` (object), `isInvisible` (boolean), `isSession` (boolean), `apiDomain` (string).
- Fixed wire values: `{"type":"ReCaptchaV2TaskProxyLess"}`.

### ReCaptchaV2EnterpriseTask

Family: `recaptcha_v2_enterprise`. [Official contract](https://docs.capsolver.com/en/guide/captcha/ReCaptchaV2/).

- Required: `websiteURL` (string), `websiteKey` (string), `proxy` (string).
- Optional: `cookies` (array), `pageAction` (string), `recaptchaDataSValue` (string), `enterprisePayload` (object), `isInvisible` (boolean), `isSession` (boolean), `apiDomain` (string).
- Fixed wire values: `{"type":"ReCaptchaV2EnterpriseTask"}`.

### ReCaptchaV2EnterpriseTaskProxyLess

Family: `recaptcha_v2_enterprise`. [Official contract](https://docs.capsolver.com/en/guide/captcha/ReCaptchaV2/).

- Required: `websiteURL` (string), `websiteKey` (string).
- Optional: `cookies` (array), `proxy` (string), `pageAction` (string), `recaptchaDataSValue` (string), `enterprisePayload` (object), `isInvisible` (boolean), `isSession` (boolean), `apiDomain` (string).
- Fixed wire values: `{"type":"ReCaptchaV2EnterpriseTaskProxyLess"}`.

### ReCaptchaV2Task

Family: `recaptcha_v2`. [Official contract](https://docs.capsolver.com/en/guide/captcha/ReCaptchaV2/).

- Required: `websiteURL` (string), `websiteKey` (string), `proxy` (string).
- Optional: `cookies` (array), `pageAction` (string), `recaptchaDataSValue` (string), `enterprisePayload` (object), `isInvisible` (boolean), `isSession` (boolean), `apiDomain` (string).
- Fixed wire values: `{"type":"ReCaptchaV2Task"}`.

### ReCaptchaV3Task

Family: `recaptcha_v3`. [Official contract](https://docs.capsolver.com/en/guide/captcha/ReCaptchaV3/).

- Required: `websiteURL` (string), `websiteKey` (string), `proxy` (string).
- Optional: `pageAction` (string), `enterprisePayload` (object), `isSession` (boolean), `apiDomain` (string).
- Fixed wire values: `{"type":"ReCaptchaV3Task"}`.

### ReCaptchaV3TaskProxyLess

Family: `recaptcha_v3`. [Official contract](https://docs.capsolver.com/en/guide/captcha/ReCaptchaV3/).

- Required: `websiteURL` (string), `websiteKey` (string).
- Optional: `proxy` (string), `pageAction` (string), `enterprisePayload` (object), `isSession` (boolean), `apiDomain` (string).
- Fixed wire values: `{"type":"ReCaptchaV3TaskProxyLess"}`.

### ReCaptchaV3EnterpriseTask

Family: `recaptcha_v3_enterprise`. [Official contract](https://docs.capsolver.com/en/guide/captcha/ReCaptchaV3/).

- Required: `websiteURL` (string), `websiteKey` (string), `proxy` (string).
- Optional: `pageAction` (string), `enterprisePayload` (object), `isSession` (boolean), `apiDomain` (string).
- Fixed wire values: `{"type":"ReCaptchaV3EnterpriseTask"}`.

### ReCaptchaV3EnterpriseTaskProxyLess

Family: `recaptcha_v3_enterprise`. [Official contract](https://docs.capsolver.com/en/guide/captcha/ReCaptchaV3/).

- Required: `websiteURL` (string), `websiteKey` (string).
- Optional: `proxy` (string), `pageAction` (string), `enterprisePayload` (object), `isSession` (boolean), `apiDomain` (string).
- Fixed wire values: `{"type":"ReCaptchaV3EnterpriseTaskProxyLess"}`.

### ReCaptchaV3M1Task

Family: `recaptcha_v3`. [Official contract](https://docs.capsolver.com/en/guide/captcha/ReCaptchaV3/).

- Required: `websiteURL` (string), `websiteKey` (string), `proxy` (string).
- Optional: `pageAction` (string), `enterprisePayload` (object), `isSession` (boolean), `apiDomain` (string).
- Fixed wire values: `{"type":"ReCaptchaV3M1Task"}`.

### ReCaptchaV3M1TaskProxyLess

Family: `recaptcha_v3`. [Official contract](https://docs.capsolver.com/en/guide/captcha/ReCaptchaV3/).

- Required: `websiteURL` (string), `websiteKey` (string).
- Optional: `proxy` (string), `pageAction` (string), `enterprisePayload` (object), `isSession` (boolean), `apiDomain` (string).
- Fixed wire values: `{"type":"ReCaptchaV3M1TaskProxyLess"}`.

### ReCaptchaV3EnterpriseM1Task

Family: `recaptcha_v3_enterprise`. [Official contract](https://docs.capsolver.com/en/guide/captcha/ReCaptchaV3/).

- Required: `websiteURL` (string), `websiteKey` (string), `proxy` (string).
- Optional: `pageAction` (string), `enterprisePayload` (object), `isSession` (boolean), `apiDomain` (string).
- Fixed wire values: `{"type":"ReCaptchaV3EnterpriseM1Task"}`.

### ReCaptchaV3EnterpriseM1TaskProxyLess

Family: `recaptcha_v3_enterprise`. [Official contract](https://docs.capsolver.com/en/guide/captcha/ReCaptchaV3/).

- Required: `websiteURL` (string), `websiteKey` (string).
- Optional: `proxy` (string), `pageAction` (string), `enterprisePayload` (object), `isSession` (boolean), `apiDomain` (string).
- Fixed wire values: `{"type":"ReCaptchaV3EnterpriseM1TaskProxyLess"}`.

### AntiAwsWafTask

Family: `aws_waf`. [Official contract](https://docs.capsolver.com/en/guide/captcha/awsWaf/).

- Required: `proxy` (string), `websiteURL` (string).
- Optional: `awsKey` (string), `awsIv` (string), `awsContext` (string), `awsChallengeJS` (string), `awsApiJs` (string), `awsProblemUrl` (string), `awsApiKey` (string), `awsExistingToken` (string).
- Fixed wire values: `{"type":"AntiAwsWafTask"}`.

### AntiAwsWafTaskProxyLess

Family: `aws_waf`. [Official contract](https://docs.capsolver.com/en/guide/captcha/awsWaf/).

- Required: `websiteURL` (string).
- Optional: `proxy` (string), `awsKey` (string), `awsIv` (string), `awsContext` (string), `awsChallengeJS` (string), `awsApiJs` (string), `awsProblemUrl` (string), `awsApiKey` (string), `awsExistingToken` (string).
- Fixed wire values: `{"type":"AntiAwsWafTaskProxyLess"}`.

### AntiBotdeflectorTaskProxyLess

Family: `botdeflector`. [Official contract](https://docs.capsolver.com/en/guide/captcha/botdeflector/).

- Required: `websiteURL` (string), `domain` (string), `flowToken` (string).
- Optional: None.
- Fixed wire values: `{"type":"AntiBotdeflectorTaskProxyLess"}`.

### AntiCloudflareTask

Family: `cloudflare_challenge`. [Official contract](https://docs.capsolver.com/en/guide/captcha/cloudflare_challenge/).

- Required: `websiteURL` (string), `proxy` (string).
- Optional: `userAgent` (string), `html` (string).
- Fixed wire values: `{"type":"AntiCloudflareTask"}`.

### AntiTurnstileTaskProxyLess

Family: `turnstile`. [Official contract](https://docs.capsolver.com/en/guide/captcha/cloudflare_turnstile/).

- Required: `websiteURL` (string), `websiteKey` (string).
- Optional: `metadata` (object), `metadata.action` (string), `metadata.cdata` (string).
- Fixed wire values: `{"type":"AntiTurnstileTaskProxyLess"}`.

### DataDomeSliderTask

Family: `datadome`. [Official contract](https://docs.capsolver.com/en/guide/captcha/datadome/).

- Required: `proxy` (string), `captchaUrl` (string), `userAgent` (string).
- Optional: `html` (string).
- Fixed wire values: `{"type":"DataDomeSliderTask"}`.

### AwsWafClassification

Family: `aws_recognition`. [Official contract](https://docs.capsolver.com/en/guide/recognition/AwsWafClassification/).

- Required: `images` (array), `question` (string).
- Optional: `websiteURL` (string).
- Fixed wire values: `{"type":"AwsWafClassification"}`.

### ImageToTextTask

Family: `image_to_text`. [Official contract](https://docs.capsolver.com/en/guide/recognition/ImageToTextTask/).

- Required: None.
- Optional: `websiteURL` (string), `body` (string), `images` (array), `module` (string).
- Fixed wire values: `{"type":"ImageToTextTask"}`.
- Alternatives: `body` or `images`.

### ReCaptchaV2Classification

Family: `recaptcha_recognition`. [Official contract](https://docs.capsolver.com/en/guide/recognition/ReCaptchaClassification/).

- Required: `image` (string), `question` (string).
- Optional: `websiteURL` (string), `websiteKey` (string).
- Fixed wire values: `{"type":"ReCaptchaV2Classification"}`.

### VisionEngine

Family: `vision_engine`. [Official contract](https://docs.capsolver.com/en/guide/recognition/VisionEngine/).

- Required: `module` (string), `image` (string).
- Optional: `websiteURL` (string), `imageBackground` (string), `question` (string).
- Fixed wire values: `{"type":"VisionEngine"}`.

## 2captcha (67 variants)

### AlibabaTaskProxyless

Family: `alibaba`. [Official contract](https://2captcha.com/api-docs/alibaba-captcha).

- Required: `websiteURL` (string), `sceneId` (string), `prefix` (string).
- Optional: `userId` (string), `userUserId` (string), `verifyType` (string), `region` (string), `userCertifyId` (string), `apiGetLib` (string), `userAgent` (string).
- Fixed wire values: `{"type":"AlibabaTaskProxyless"}`.

### AlibabaTask

Family: `alibaba`. [Official contract](https://2captcha.com/api-docs/alibaba-captcha).

- Required: `websiteURL` (string), `sceneId` (string), `prefix` (string), `proxyType` (string), `proxyAddress` (string), `proxyPort` (number).
- Optional: `userId` (string), `userUserId` (string), `verifyType` (string), `region` (string), `userCertifyId` (string), `apiGetLib` (string), `userAgent` (string), `proxyLogin` (string), `proxyPassword` (string).
- Fixed wire values: `{"type":"AlibabaTask"}`.

### AltchaTaskProxyless

Family: `altcha`. [Official contract](https://2captcha.com/api-docs/altcha).

- Required: `websiteURL` (string).
- Optional: `challengeURL` (string), `challengeJSON` (string).
- Fixed wire values: `{"type":"AltchaTaskProxyless"}`.

### AltchaTask

Family: `altcha`. [Official contract](https://2captcha.com/api-docs/altcha).

- Required: `websiteURL` (string), `proxyType` (string), `proxyAddress` (string), `proxyPort` (integer).
- Optional: `challengeURL` (string), `challengeJSON` (string), `proxyLogin` (string), `proxyPassword` (string).
- Fixed wire values: `{"type":"AltchaTask"}`.

### AmazonTaskProxyless

Family: `aws_waf`. [Official contract](https://2captcha.com/api-docs/amazon-aws-waf-captcha).

- Required: `websiteURL` (string), `websiteKey` (string).
- Optional: `iv` (string), `context` (string), `challengeScript` (string), `captchaScript` (string), `jsapiScript` (string).
- Fixed wire values: `{"type":"AmazonTaskProxyless"}`.
- Alternatives: `iv` or `jsapiScript`.

### AmazonTask

Family: `aws_waf`. [Official contract](https://2captcha.com/api-docs/amazon-aws-waf-captcha).

- Required: `websiteURL` (string), `websiteKey` (string), `proxyType` (string), `proxyAddress` (string), `proxyPort` (integer).
- Optional: `iv` (string), `context` (string), `challengeScript` (string), `captchaScript` (string), `proxyLogin` (string), `proxyPassword` (string), `jsapiScript` (string).
- Fixed wire values: `{"type":"AmazonTask"}`.
- Alternatives: `iv` or `jsapiScript`.

### AntiCyberSiAraTask

Family: `cybersiara`. [Official contract](https://2captcha.com/api-docs/anti-cyber-siara).

- Required: `websiteURL` (string), `SlideMasterUrlId` (string), `userAgent` (string), `proxyType` (string), `proxyAddress` (string), `proxyPort` (integer).
- Optional: `proxyLogin` (string), `proxyPassword` (string).
- Fixed wire values: `{"type":"AntiCyberSiAraTask"}`.

### AntiCyberSiAraTaskProxyless

Family: `cybersiara`. [Official contract](https://2captcha.com/api-docs/anti-cyber-siara).

- Required: `websiteURL` (string), `SlideMasterUrlId` (string), `userAgent` (string).
- Optional: None.
- Fixed wire values: `{"type":"AntiCyberSiAraTaskProxyless"}`.

### FunCaptchaTaskProxyless

Family: `funcaptcha`. [Official contract](https://2captcha.com/api-docs/arkoselabs-funcaptcha).

- Required: `websiteURL` (string), `websitePublicKey` (string).
- Optional: `funcaptchaApiJSSubdomain` (string), `data` (string), `userAgent` (string).
- Fixed wire values: `{"type":"FunCaptchaTaskProxyless"}`.

### FunCaptchaTask

Family: `funcaptcha`. [Official contract](https://2captcha.com/api-docs/arkoselabs-funcaptcha).

- Required: `websiteURL` (string), `websitePublicKey` (string), `proxyType` (string), `proxyAddress` (string), `proxyPort` (integer).
- Optional: `funcaptchaApiJSSubdomain` (string), `data` (string), `userAgent` (string), `proxyLogin` (string), `proxyPassword` (string).
- Fixed wire values: `{"type":"FunCaptchaTask"}`.

### AtbCaptchaTaskProxyless

Family: `atb`. [Official contract](https://2captcha.com/api-docs/atb-captcha).

- Required: `websiteURL` (string), `appId` (string), `apiServer` (string).
- Optional: None.
- Fixed wire values: `{"type":"AtbCaptchaTaskProxyless"}`.

### AtbCaptchaTask

Family: `atb`. [Official contract](https://2captcha.com/api-docs/atb-captcha).

- Required: `websiteURL` (string), `appId` (string), `apiServer` (string), `proxyType` (string), `proxyAddress` (string), `proxyPort` (integer).
- Optional: `proxyLogin` (string), `proxyPassword` (string).
- Fixed wire values: `{"type":"AtbCaptchaTask"}`.

### AudioTask

Family: `audio`. [Official contract](https://2captcha.com/api-docs/audio).

- Required: `body` (string), `lang` (string).
- Optional: None.
- Fixed wire values: `{"type":"AudioTask"}`.

### BasiliskTaskProxyless

Family: `basilisk`. [Official contract](https://2captcha.com/api-docs/basilisk-captcha).

- Required: `websiteURL` (string), `websiteKey` (string).
- Optional: `userAgent` (string).
- Fixed wire values: `{"type":"BasiliskTaskProxyless"}`.

### BasiliskTask

Family: `basilisk`. [Official contract](https://2captcha.com/api-docs/basilisk-captcha).

- Required: `websiteURL` (string), `websiteKey` (string), `proxyType` (string), `proxyAddress` (string), `proxyPort` (number).
- Optional: `userAgent` (string), `proxyLogin` (string), `proxyPassword` (string).
- Fixed wire values: `{"type":"BasiliskTask"}`.

### BinanceTask

Family: `binance`. [Official contract](https://2captcha.com/api-docs/binance-captcha).

- Required: `websiteURL` (string), `websiteKey` (string), `validateId` (string), `proxyType` (string), `proxyAddress` (string), `proxyPort` (integer).
- Optional: `userAgent` (string), `proxyLogin` (string), `proxyPassword` (string).
- Fixed wire values: `{"type":"BinanceTask"}`.

### BinanceTaskproxyless

Family: `binance`. [Official contract](https://2captcha.com/api-docs/binance-captcha).

- Required: `websiteURL` (string), `websiteKey` (string), `validateId` (string).
- Optional: `userAgent` (string), None.
- Fixed wire values: `{"type":"BinanceTaskproxyless"}`.

### BoundingBoxTask

Family: `bounding_box`. [Official contract](https://2captcha.com/api-docs/bounding-box).

- Required: `body` (string).
- Optional: `comment` (string), `imgInstructions` (string), `canNoAnswer` (integer).
- Fixed wire values: `{"type":"BoundingBoxTask"}`.

### CaptchaFoxTask

Family: `captchafox`. [Official contract](https://2captcha.com/api-docs/captchafox).

- Required: `websiteURL` (string), `websiteKey` (string), `userAgent` (string), `proxyType` (string), `proxyAddress` (string), `proxyPort` (integer).
- Optional: `apiServer` (string), `proxyLogin` (string), `proxyPassword` (string).
- Fixed wire values: `{"type":"CaptchaFoxTask"}`.

### CapyTaskProxyless

Family: `capy`. [Official contract](https://2captcha.com/api-docs/capy-puzzle-captcha).

- Required: `websiteURL` (string), `websiteKey` (string).
- Optional: `userAgent` (string).
- Fixed wire values: `{"type":"CapyTaskProxyless"}`.

### CapyTask

Family: `capy`. [Official contract](https://2captcha.com/api-docs/capy-puzzle-captcha).

- Required: `websiteURL` (string), `websiteKey` (string), `proxyType` (string), `proxyAddress` (string), `proxyPort` (integer).
- Optional: `userAgent` (string), `proxyLogin` (string), `proxyPassword` (string).
- Fixed wire values: `{"type":"CapyTask"}`.

### TurnstileTaskProxyless

Family: `turnstile`. [Official contract](https://2captcha.com/api-docs/cloudflare-turnstile).

- Required: `websiteURL` (string), `websiteKey` (string).
- Optional: `action` (string), `data` (string), `pagedata` (string).
- Fixed wire values: `{"type":"TurnstileTaskProxyless"}`.

### TurnstileTask

Family: `turnstile`. [Official contract](https://2captcha.com/api-docs/cloudflare-turnstile).

- Required: `websiteURL` (string), `websiteKey` (string), `proxyType` (string), `proxyAddress` (string), `proxyPort` (integer).
- Optional: `action` (string), `data` (string), `pagedata` (string), `proxyLogin` (string), `proxyPassword` (string).
- Fixed wire values: `{"type":"TurnstileTask"}`.

### CoordinatesTask

Family: `coordinates`. [Official contract](https://2captcha.com/api-docs/coordinates).

- Required: `body` (string).
- Optional: `comment` (string), `imgInstructions` (string), `minClicks` (integer), `maxClicks` (integer).
- Fixed wire values: `{"type":"CoordinatesTask"}`.

### CutCaptchaTaskProxyless

Family: `cutcaptcha`. [Official contract](https://2captcha.com/api-docs/cutcaptcha).

- Required: `websiteURL` (string), `miseryKey` (string), `apiKey` (string).
- Optional: None.
- Fixed wire values: `{"type":"CutCaptchaTaskProxyless"}`.

### CutCaptchaTask

Family: `cutcaptcha`. [Official contract](https://2captcha.com/api-docs/cutcaptcha).

- Required: `websiteURL` (string), `miseryKey` (string), `apiKey` (string), `proxyType` (string), `proxyAddress` (string), `proxyPort` (integer).
- Optional: `proxyLogin` (string), `proxyPassword` (string).
- Fixed wire values: `{"type":"CutCaptchaTask"}`.

### DataDomeSliderTask

Family: `datadome`. [Official contract](https://2captcha.com/api-docs/datadome-slider-captcha).

- Required: `websiteURL` (string), `captchaUrl` (string), `userAgent` (string), `proxyType` (string), `proxyAddress` (string), `proxyPort` (integer).
- Optional: `proxyLogin` (string), `proxyPassword` (string).
- Fixed wire values: `{"type":"DataDomeSliderTask"}`.

### DragAndDropTask

Family: `drag_and_drop`. [Official contract](https://2captcha.com/api-docs/drag-and-drop).

- Required: `background` (string), `images` (array).
- Optional: `comment` (string).
- Fixed wire values: `{"type":"DragAndDropTask"}`.

### DrawAroundTask

Family: `draw_around`. [Official contract](https://2captcha.com/api-docs/draw-around).

- Required: `body` (string).
- Optional: `comment` (string), `imgInstructions` (string).
- Fixed wire values: `{"type":"DrawAroundTask"}`.

### FriendlyCaptchaTaskProxyless

Family: `friendly`. [Official contract](https://2captcha.com/api-docs/friendly-captcha).

- Required: `websiteURL` (string), `websiteKey` (string).
- Optional: `version` (string), `moduleScript` (string), `nomoduleScript` (string).
- Fixed wire values: `{"type":"FriendlyCaptchaTaskProxyless"}`.

### FriendlyCaptchaTask

Family: `friendly`. [Official contract](https://2captcha.com/api-docs/friendly-captcha).

- Required: `websiteURL` (string), `websiteKey` (string), `proxyType` (string), `proxyAddress` (string), `proxyPort` (integer).
- Optional: `version` (string), `moduleScript` (string), `nomoduleScript` (string), `proxyLogin` (string), `proxyPassword` (string).
- Fixed wire values: `{"type":"FriendlyCaptchaTask"}`.

### GridTask:funcaptcha_recognition

Family: `funcaptcha_recognition`. [Official contract](https://2captcha.com/api-docs/funcaptcha-grid).

- Required: `body` (string).
- Optional: `rows` (number), `columns` (number), `comment` (string), `imgInstructions` (string), `minClicks` (number), `maxClicks` (number), `canNoAnswer` (number), `previousId` (string), `imgType` (string).
- Fixed wire values: `{"type":"GridTask"}`.

### GeeTestTaskProxyless

Family: `geetest`. [Official contract](https://2captcha.com/api-docs/geetest).

- Required: `websiteURL` (string).
- Optional: `gt` (string), `challenge` (string), `geetestApiServerSubdomain` (string), `userAgent` (string), `version` (integer), `initParameters` (object), `risk_type` (string).
- Fixed wire values: `{"type":"GeeTestTaskProxyless"}`.

### GeeTestTask

Family: `geetest`. [Official contract](https://2captcha.com/api-docs/geetest).

- Required: `websiteURL` (string), `proxyType` (string), `proxyAddress` (string), `proxyPort` (integer).
- Optional: `gt` (string), `challenge` (string), `geetestApiServerSubdomain` (string), `userAgent` (string), `version` (integer), `initParameters` (object), `risk_type` (string), `proxyLogin` (string), `proxyPassword` (string).
- Fixed wire values: `{"type":"GeeTestTask"}`.

### GridTask

Family: `grid`. [Official contract](https://2captcha.com/api-docs/grid).

- Required: `body` (string).
- Optional: `rows` (integer), `columns` (integer), `comment` (string), `imgInstructions` (string), `previousId` (string), `imgType` (string), `minClicks` (integer), `maxClicks` (integer), `canNoAnswer` (integer).
- Fixed wire values: `{"type":"GridTask"}`.

### HuntTask

Family: `hunt`. [Official contract](https://2captcha.com/api-docs/hunt-captcha).

- Required: `websiteURL` (string), `apiGetLib` (string), `proxyType` (string), `proxyAddress` (string), `proxyPort` (number).
- Optional: `userAgent` (string), `data` (string), `proxyLogin` (string), `proxyPassword` (string).
- Fixed wire values: `{"type":"HuntTask"}`.

### IncapsulaTask

Family: `imperva`. [Official contract](https://2captcha.com/api-docs/imperva-incapsula).

- Required: `websiteURL` (string), `incapsulaScriptUrl` (string), `incapsulaCookies` (string), `proxyType` (string), `proxyAddress` (string), `proxyPort` (number).
- Optional: `userAgent` (string), `reese84UrlEndpoint` (string), `proxyLogin` (string), `proxyPassword` (string).
- Fixed wire values: `{"type":"IncapsulaTask"}`.

### KeyCaptchaTaskProxyless

Family: `keycaptcha`. [Official contract](https://2captcha.com/api-docs/keycaptcha).

- Required: `websiteURL` (string), `s_s_c_user_id` (string), `s_s_c_session_id` (string), `s_s_c_web_server_sign` (string), `s_s_c_web_server_sign2` (string).
- Optional: None.
- Fixed wire values: `{"type":"KeyCaptchaTaskProxyless"}`.

### KeyCaptchaTask

Family: `keycaptcha`. [Official contract](https://2captcha.com/api-docs/keycaptcha).

- Required: `websiteURL` (string), `s_s_c_user_id` (string), `s_s_c_session_id` (string), `s_s_c_web_server_sign` (string), `s_s_c_web_server_sign2` (string), `proxyType` (string), `proxyAddress` (string), `proxyPort` (integer).
- Optional: `proxyLogin` (string), `proxyPassword` (string).
- Fixed wire values: `{"type":"KeyCaptchaTask"}`.

### LeminTaskProxyless

Family: `lemin`. [Official contract](https://2captcha.com/api-docs/lemin).

- Required: `websiteURL` (string), `captchaId` (string), `divId` (string).
- Optional: `leminApiServerSubdomain` (string), `userAgent` (string).
- Fixed wire values: `{"type":"LeminTaskProxyless"}`.

### LeminTask

Family: `lemin`. [Official contract](https://2captcha.com/api-docs/lemin).

- Required: `websiteURL` (string), `captchaId` (string), `divId` (string), `proxyType` (string), `proxyAddress` (string), `proxyPort` (integer).
- Optional: `leminApiServerSubdomain` (string), `userAgent` (string), `proxyLogin` (string), `proxyPassword` (string).
- Fixed wire values: `{"type":"LeminTask"}`.

### MtCaptchaTaskProxyless

Family: `mtcaptcha`. [Official contract](https://2captcha.com/api-docs/mtcaptcha).

- Required: `websiteURL` (string), `websiteKey` (string).
- Optional: None.
- Fixed wire values: `{"type":"MtCaptchaTaskProxyless"}`.

### MtCaptchaTask

Family: `mtcaptcha`. [Official contract](https://2captcha.com/api-docs/mtcaptcha).

- Required: `websiteURL` (string), `websiteKey` (string), `proxyType` (string), `proxyAddress` (string), `proxyPort` (integer).
- Optional: `proxyLogin` (string), `proxyPassword` (string).
- Fixed wire values: `{"type":"MtCaptchaTask"}`.

### ImageToTextTask

Family: `image_to_text`. [Official contract](https://2captcha.com/api-docs/normal-captcha).

- Required: `body` (string).
- Optional: `phrase` (boolean), `case` (boolean), `numeric` (integer), `math` (boolean), `minLength` (integer), `maxLength` (integer), `comment` (string), `imgInstructions` (string).
- Fixed wire values: `{"type":"ImageToTextTask"}`.

### ProsopoTaskProxyless

Family: `prosopo`. [Official contract](https://2captcha.com/api-docs/prosopo-procaptcha).

- Required: `websiteURL` (string), `websiteKey` (string).
- Optional: None.
- Fixed wire values: `{"type":"ProsopoTaskProxyless"}`.

### ProsopoTask

Family: `prosopo`. [Official contract](https://2captcha.com/api-docs/prosopo-procaptcha).

- Required: `websiteURL` (string), `websiteKey` (string), `proxyType` (string), `proxyAddress` (string), `proxyPort` (integer).
- Optional: `proxyLogin` (string), `proxyPassword` (string).
- Fixed wire values: `{"type":"ProsopoTask"}`.

### GridTask:recaptcha_recognition

Family: `recaptcha_recognition`. [Official contract](https://2captcha.com/api-docs/recaptcha-grid).

- Required: `body` (string).
- Optional: `rows` (integer), `columns` (integer), `comment` (string), `imgInstructions` (string), `minClicks` (integer), `maxClicks` (integer), `canNoAnswer` (integer), `previousId` (string), `imgType` (string).
- Fixed wire values: `{"type":"GridTask"}`.

### RecaptchaV2TaskProxyless

Family: `recaptcha_v2`. [Official contract](https://2captcha.com/api-docs/recaptcha-v2).

- Required: `websiteURL` (string), `websiteKey` (string).
- Optional: `recaptchaDataSValue` (string), `isInvisible` (boolean), `userAgent` (string), `cookies` (string), `apiDomain` (string).
- Fixed wire values: `{"type":"RecaptchaV2TaskProxyless"}`.

### RecaptchaV2Task

Family: `recaptcha_v2`. [Official contract](https://2captcha.com/api-docs/recaptcha-v2).

- Required: `websiteURL` (string), `websiteKey` (string), `proxyType` (string), `proxyAddress` (string), `proxyPort` (integer).
- Optional: `recaptchaDataSValue` (string), `isInvisible` (boolean), `userAgent` (string), `cookies` (string), `apiDomain` (string), `proxyLogin` (string), `proxyPassword` (string).
- Fixed wire values: `{"type":"RecaptchaV2Task"}`.

### RecaptchaV2EnterpriseTaskProxyless

Family: `recaptcha_v2_enterprise`. [Official contract](https://2captcha.com/api-docs/recaptcha-v2-enterprise).

- Required: `websiteURL` (string), `websiteKey` (string).
- Optional: `enterprisePayload` (object), `isInvisible` (boolean), `userAgent` (string), `cookies` (string), `apiDomain` (string).
- Fixed wire values: `{"type":"RecaptchaV2EnterpriseTaskProxyless"}`.

### RecaptchaV2EnterpriseTask

Family: `recaptcha_v2_enterprise`. [Official contract](https://2captcha.com/api-docs/recaptcha-v2-enterprise).

- Required: `websiteURL` (string), `websiteKey` (string), `proxyType` (string), `proxyAddress` (string), `proxyPort` (integer).
- Optional: `enterprisePayload` (object), `isInvisible` (boolean), `userAgent` (string), `cookies` (string), `apiDomain` (string), `proxyLogin` (string), `proxyPassword` (string).
- Fixed wire values: `{"type":"RecaptchaV2EnterpriseTask"}`.

### RecaptchaV3TaskProxyless

Family: `recaptcha_v3`. [Official contract](https://2captcha.com/api-docs/recaptcha-v3).

- Required: `websiteURL` (string), `websiteKey` (string), `minScore` (number).
- Optional: `pageAction` (string), `isEnterprise` (boolean), `apiDomain` (string).
- Fixed wire values: `{"type":"RecaptchaV3TaskProxyless"}`.

### RotateTask

Family: `rotate`. [Official contract](https://2captcha.com/api-docs/rotate).

- Required: `body` (string).
- Optional: `angle` (integer), `comment` (string), `imgInstructions` (string).
- Fixed wire values: `{"type":"RotateTask"}`.

### TemuImageTask

Family: `temu_recognition`. [Official contract](https://2captcha.com/api-docs/temu-captcha).

- Required: `image` (string), `parts` (array).
- Optional: None.
- Fixed wire values: `{"type":"TemuImageTask"}`.

### TencentTaskProxyless

Family: `tencent`. [Official contract](https://2captcha.com/api-docs/tencent).

- Required: `websiteURL` (string), `appId` (string).
- Optional: `captchaScript` (string).
- Fixed wire values: `{"type":"TencentTaskProxyless"}`.

### TencentTask

Family: `tencent`. [Official contract](https://2captcha.com/api-docs/tencent).

- Required: `websiteURL` (string), `appId` (string), `proxyType` (string), `proxyAddress` (string), `proxyPort` (integer).
- Optional: `captchaScript` (string), `proxyLogin` (string), `proxyPassword` (string).
- Fixed wire values: `{"type":"TencentTask"}`.

### TextCaptchaTask

Family: `text_captcha`. [Official contract](https://2captcha.com/api-docs/text).

- Required: `comment` (string).
- Optional: None.
- Fixed wire values: `{"type":"TextCaptchaTask"}`.

### TspdTask

Family: `tspd`. [Official contract](https://2captcha.com/api-docs/tspd-captcha).

- Required: `websiteURL` (string), `tspdCookie` (string), `htmlPageBase64` (string), `proxyType` (string), `proxyAddress` (string), `proxyPort` (number).
- Optional: `proxyLogin` (string), `proxyPassword` (string), `userAgent` (string).
- Fixed wire values: `{"type":"TspdTask"}`.

### VKCaptchaTask

Family: `vk`. [Official contract](https://2captcha.com/api-docs/vk-captcha).

- Required: `redirectUri` (string), `userAgent` (string), `proxyType` (string), `proxyAddress` (string), `proxyPort` (integer).
- Optional: `proxyLogin` (string), `proxyPassword` (string).
- Fixed wire values: `{"type":"VKCaptchaTask"}`.

### VKCaptchaImageTask

Family: `vk_recognition`. [Official contract](https://2captcha.com/api-docs/vk-captcha).

- Required: `image` (string), `steps` (array).
- Optional: None.
- Fixed wire values: `{"type":"VKCaptchaImageTask"}`.

### YandexSmartCaptchaTaskProxyless

Family: `yandex`. [Official contract](https://2captcha.com/api-docs/yandex-smart-captcha).

- Required: `websiteURL` (string), `websiteKey` (string).
- Optional: `userAgent` (string), `cookies` (string).
- Fixed wire values: `{"type":"YandexSmartCaptchaTaskProxyless"}`.

### YandexSmartCaptchaTask

Family: `yandex`. [Official contract](https://2captcha.com/api-docs/yandex-smart-captcha).

- Required: `websiteURL` (string), `websiteKey` (string), `proxyType` (string), `proxyAddress` (string), `proxyPort` (number).
- Optional: `userAgent` (string), `cookies` (string), `proxyLogin` (string), `proxyPassword` (string).
- Fixed wire values: `{"type":"YandexSmartCaptchaTask"}`.

### SmartCaptchaTask

Family: `yandex_recognition`. [Official contract](https://2captcha.com/api-docs/yandex-smart-captcha).

- Required: `image` (string), `imgInstructions` (string).
- Optional: `comment` (string).
- Fixed wire values: `{"type":"SmartCaptchaTask"}`.

### PazlCaptchaTask

Family: `yandex_recognition`. [Official contract](https://2captcha.com/api-docs/yandex-smart-captcha).

- Required: `image` (string), `task` (string).
- Optional: None.
- Fixed wire values: `{"type":"PazlCaptchaTask"}`.

### YidunTaskProxyless

Family: `yidun`. [Official contract](https://2captcha.com/api-docs/yidun-necaptcha).

- Required: `websiteURL` (string), `websiteKey` (string).
- Optional: `userAgent` (string), `yidunGetLib` (string), `yidunApiServerSubdomain` (string), `challenge` (string), `hcg` (string), `hct` (number).
- Fixed wire values: `{"type":"YidunTaskProxyless"}`.

### YidunTask

Family: `yidun`. [Official contract](https://2captcha.com/api-docs/yidun-necaptcha).

- Required: `websiteURL` (string), `websiteKey` (string), `proxyType` (string), `proxyAddress` (string), `proxyPort` (number).
- Optional: `userAgent` (string), `yidunGetLib` (string), `yidunApiServerSubdomain` (string), `challenge` (string), `hcg` (string), `hct` (number), `proxyLogin` (string), `proxyPassword` (string).
- Fixed wire values: `{"type":"YidunTask"}`.

### RecaptchaV3TaskProxyless:enterprise

Family: `recaptcha_v3_enterprise`. [Official contract](https://2captcha.com/api-docs/recaptcha-v3).

- Required: `websiteURL` (string), `websiteKey` (string), `minScore` (number).
- Optional: `pageAction` (string), `apiDomain` (string).
- Fixed wire values: `{"type":"RecaptchaV3TaskProxyless","isEnterprise":true}`.

## capmonster (39 variants)

### CustomTask:Basilisk

Family: `basilisk`. [Official contract](https://docs.capmonster.cloud/docs/captchas/Basilisk-task/).

- Required: `websiteURL` (string), `websiteKey` (string).
- Optional: `userAgent` (string), `proxyType` (string), `proxyAddress` (string), `proxyPort` (integer), `proxyLogin` (string), `proxyPassword` (string).
- Fixed wire values: `{"type":"CustomTask","class":"Basilisk"}`.

### ImageToTextTask

Family: `image_to_text`. [Official contract](https://docs.capmonster.cloud/docs/captchas/ImageToText/image-to-text/).

- Required: `body` (string).
- Optional: `capMonsterModule` (string), `recognizingThreshold` (integer), `case` (boolean), `numeric` (integer), `math` (boolean).
- Fixed wire values: `{"type":"ImageToTextTask"}`.

### CustomTask:alibaba

Family: `alibaba`. [Official contract](https://docs.capmonster.cloud/docs/captchas/alibaba-task/).

- Required: `websiteURL` (string), `metadata.sceneId` (string), `metadata.prefix` (string).
- Optional: `metadata.userId` (string), `metadata.userUserId` (string), `metadata.verifyType` (string), `metadata.region` (string), `metadata.UserCertifyId` (string), `metadata.apiGetLib` (string), `metadata.punishUrl` (string), `metadata.cookieRequired` (boolean), `userAgent` (string), `proxyType` (string), `proxyAddress` (string), `proxyPort` (integer), `proxyLogin` (string), `proxyPassword` (string), `metadata` (object).
- Fixed wire values: `{"type":"CustomTask","class":"alibaba"}`.

### CustomTask:altcha

Family: `altcha`. [Official contract](https://docs.capmonster.cloud/docs/captchas/altcha-task/).

- Required: `websiteURL` (string), `websiteKey` (string).
- Optional: `metadata.challenge` (string), `metadata.iterations` (string), `metadata.salt` (string), `metadata.signature` (string), `userAgent` (string), `proxyType` (string), `proxyAddress` (string), `proxyPort` (integer), `proxyLogin` (string), `proxyPassword` (string), `metadata` (object).
- Fixed wire values: `{"type":"CustomTask","class":"altcha"}`.

### AmazonTask:1

Family: `aws_waf`. [Official contract](https://docs.capmonster.cloud/docs/captchas/amazon-task/).

- Required: `websiteURL` (string), `websiteKey` (string), `captchaScript` (string).
- Optional: `cookieSolution` (boolean), `userAgent` (string), `proxyType` (string), `proxyAddress` (string), `proxyPort` (integer), `proxyLogin` (string), `proxyPassword` (string).
- Fixed wire values: `{"type":"AmazonTask"}`.

### AmazonTask:2

Family: `aws_waf`. [Official contract](https://docs.capmonster.cloud/docs/captchas/amazon-task/).

- Required: `websiteURL` (string), `challengeScript` (string), `websiteKey` (string), `context` (string), `iv` (string).
- Optional: `captchaScript` (string), `cookieSolution` (boolean), `proxyType` (string), `proxyAddress` (string), `proxyPort` (integer), `proxyLogin` (string), `proxyPassword` (string).
- Fixed wire values: `{"type":"AmazonTask"}`.

### AmazonTask:3

Family: `aws_waf`. [Official contract](https://docs.capmonster.cloud/docs/captchas/amazon-task/).

- Required: `websiteURL` (string), `challengeScript` (string), `context` (string), `iv` (string).
- Optional: `cookieSolution` (boolean), `proxyType` (string), `proxyAddress` (string), `proxyPort` (integer), `proxyLogin` (string), `proxyPassword` (string).
- Fixed wire values: `{"type":"AmazonTask"}`.

### BinanceTask

Family: `binance`. [Official contract](https://docs.capmonster.cloud/docs/captchas/binance/).

- Required: `websiteURL` (string), `websiteKey` (string), `validateId` (string).
- Optional: `userAgent` (string), `proxyType` (string), `proxyAddress` (string), `proxyPort` (integer), `proxyLogin` (string), `proxyPassword` (string).
- Fixed wire values: `{"type":"BinanceTask"}`.

### ComplexImageTask:recognition:bills_audio

Family: `complex_image`. [Official contract](https://docs.capmonster.cloud/docs/captchas/compleximage/bills_audio/).

- Required: `imagesBase64` (array).
- Optional: None.
- Fixed wire values: `{"type":"ComplexImageTask","class":"recognition","metadata.Task":"bills_audio","metadata.PayloadType":"Audio"}`.

### ComplexImageTask:recognition:shein

Family: `complex_image`. [Official contract](https://docs.capmonster.cloud/docs/captchas/compleximage/shein/).

- Required: `imagesBase64` (array).
- Optional: None.
- Fixed wire values: `{"type":"ComplexImageTask","class":"recognition","metadata.Task":"shein"}`.

### ComplexImageTask:recognition:bls

Family: `complex_image`. [Official contract](https://docs.capmonster.cloud/docs/captchas/compleximage/bls/).

- Required: `imagesBase64` (array), `metadata.TaskArgument` (string).
- Optional: `metadata` (object).
- Fixed wire values: `{"type":"ComplexImageTask","class":"recognition","metadata.Task":"bls_3x3"}`.

### ComplexImageTask:recognition:baidu

Family: `complex_image`. [Official contract](https://docs.capmonster.cloud/docs/captchas/compleximage/baidu/).

- Required: `imagesBase64` (array).
- Optional: None.
- Fixed wire values: `{"type":"ComplexImageTask","class":"recognition","metadata.Task":"baidu"}`.

### ComplexImageTask:recognition:betpunch_3x3_rotate

Family: `complex_image`. [Official contract](https://docs.capmonster.cloud/docs/captchas/compleximage/betpunch_3x3_rotate/).

- Required: `imagesBase64` (array).
- Optional: None.
- Fixed wire values: `{"type":"ComplexImageTask","class":"recognition","metadata.Task":"betpunch_3x3_rotate"}`.

### ComplexImageTask:recognition:oocl_rotate_double_new

Family: `complex_image`. [Official contract](https://docs.capmonster.cloud/docs/captchas/compleximage/oocl_rotate_double_new/).

- Required: `imagesBase64` (array).
- Optional: None.
- Fixed wire values: `{"type":"ComplexImageTask","class":"recognition","metadata.Task":"oocl_rotate_double_new"}`.

### ComplexImageTask:recognition:oocl_rotate_new

Family: `complex_image`. [Official contract](https://docs.capmonster.cloud/docs/captchas/compleximage/oocl_rotate_new/).

- Required: `imagesBase64` (array).
- Optional: None.
- Fixed wire values: `{"type":"ComplexImageTask","class":"recognition","metadata.Task":"oocl_rotate_new"}`.

### ComplexImageTask:recognition:dli_ensemble

Family: `complex_image`. [Official contract](https://docs.capmonster.cloud/docs/captchas/compleximage/dli_ensemble/).

- Required: `imagesBase64` (array).
- Optional: None.
- Fixed wire values: `{"type":"ComplexImageTask","class":"recognition","metadata.Task":"dli"}`.

### ComplexImageTask:recognition:mathsum

Family: `complex_image`. [Official contract](https://docs.capmonster.cloud/docs/captchas/compleximage/mathsum/).

- Required: `imagesBase64` (array).
- Optional: None.
- Fixed wire values: `{"type":"ComplexImageTask","class":"recognition","metadata.Task":"MathSum"}`.

### ComplexImageTask:recognition:portugal_text_find_icon

Family: `complex_image`. [Official contract](https://docs.capmonster.cloud/docs/captchas/compleximage/portugal_text_find_icon/).

- Required: `imagesBase64` (array), `metadata.TaskArgument` (string).
- Optional: `metadata` (object).
- Fixed wire values: `{"type":"ComplexImageTask","class":"recognition","metadata.Task":"portugal_text_find_icon"}`.

### CustomTask:DataDome

Family: `datadome`. [Official contract](https://docs.capmonster.cloud/docs/captchas/datadome/).

- Required: `websiteURL` (string), `metadata.datadomeCookie` (string), `proxyType` (string), `proxyAddress` (string), `proxyPort` (integer).
- Optional: `metadata.captchaUrl` (string), `metadata.datadomeVersion` (string), `proxyLogin` (string), `proxyPassword` (string), `userAgent` (string), `metadata` (object).
- Fixed wire values: `{"type":"CustomTask","class":"DataDome"}`.

### CustomTask:friendly

Family: `friendly`. [Official contract](https://docs.capmonster.cloud/docs/captchas/friendly-task/).

- Required: `websiteURL` (string), `websiteKey` (string), `metadata.apiGetLib` (string).
- Optional: `userAgent` (string), `proxyType` (string), `proxyAddress` (string), `proxyPort` (integer), `proxyLogin` (string), `proxyPassword` (string), `metadata` (object).
- Fixed wire values: `{"type":"CustomTask","class":"friendly"}`.

### FunCaptchaTask

Family: `funcaptcha`. [Official contract](https://docs.capmonster.cloud/docs/captchas/funcaptcha-task/).

- Required: `websiteURL` (string), `websitePublicKey` (string), `proxyType` (string), `proxyAddress` (string), `proxyPort` (integer).
- Optional: `data` (string), `funcaptchaApiJSSubdomain` (string), `userAgent` (string), `cookies` (string), `proxyLogin` (string), `proxyPassword` (string).
- Fixed wire values: `{"type":"FunCaptchaTask"}`.

### GeeTestTask:1

Family: `geetest`. [Official contract](https://docs.capmonster.cloud/docs/captchas/geetest-task/).

- Required: `websiteURL` (string).
- Optional: `gt` (string), `challenge` (string), `geetestApiServerSubdomain` (string), `geetestGetLib` (string), `userAgent` (string), `proxyType` (string), `proxyAddress` (string), `proxyPort` (integer), `proxyLogin` (string), `proxyPassword` (string).
- Fixed wire values: `{"type":"GeeTestTask","version":3}`.

### GeeTestTask:2

Family: `geetest`. [Official contract](https://docs.capmonster.cloud/docs/captchas/geetest-task/).

- Required: `websiteURL` (string).
- Optional: `gt` (string), `geetestApiServerSubdomain` (string), `geetestGetLib` (string), `initParameters` (object), `userAgent` (string), `proxyType` (string), `proxyAddress` (string), `proxyPort` (integer), `proxyLogin` (string), `proxyPassword` (string).
- Fixed wire values: `{"type":"GeeTestTask","version":4}`.

### CustomTask:HUNT

Family: `hunt`. [Official contract](https://docs.capmonster.cloud/docs/captchas/hunt-task/).

- Required: `websiteURL` (string), `metadata.apiGetLib` (string), `proxyType` (string), `proxyAddress` (string), `proxyPort` (integer).
- Optional: `metadata.data` (string), `metadata.widgetUrl` (string), `userAgent` (string), `proxyLogin` (string), `proxyPassword` (string), `metadata` (object).
- Fixed wire values: `{"type":"CustomTask","class":"HUNT"}`.

### CustomTask:Imperva

Family: `imperva`. [Official contract](https://docs.capmonster.cloud/docs/captchas/incapsula/).

- Required: `websiteURL` (string), `metadata.incapsulaCookies` (string), `proxyType` (string), `proxyAddress` (string), `proxyPort` (integer).
- Optional: `metadata.incapsulaScriptUrl` (string), `proxyLogin` (string), `proxyPassword` (string), `metadata.reese84UrlEndpoint` (string), `userAgent` (string), `metadata` (object).
- Fixed wire values: `{"type":"CustomTask","class":"Imperva"}`.

### MTCaptchaTask

Family: `mtcaptcha`. [Official contract](https://docs.capmonster.cloud/docs/captchas/mtcaptcha-task/).

- Required: `websiteURL` (string), `websiteKey` (string).
- Optional: `pageAction` (string), `isInvisible` (boolean), `userAgent` (string), `proxyType` (string), `proxyAddress` (string), `proxyPort` (integer), `proxyLogin` (string), `proxyPassword` (string).
- Fixed wire values: `{"type":"MTCaptchaTask"}`.

### RecaptchaV2Task

Family: `recaptcha_v2`. [Official contract](https://docs.capmonster.cloud/docs/captchas/no-captcha-task/).

- Required: `websiteURL` (string), `websiteKey` (string).
- Optional: `recaptchaDataSValue` (string), `userAgent` (string), `cookies` (string), `isInvisible` (boolean), `proxyType` (string), `proxyAddress` (string), `proxyPort` (integer), `proxyLogin` (string), `proxyPassword` (string).
- Fixed wire values: `{"type":"RecaptchaV2Task"}`.

### ProsopoTask

Family: `prosopo`. [Official contract](https://docs.capmonster.cloud/docs/captchas/prosopo-task/).

- Required: `websiteURL` (string), `websiteKey` (string).
- Optional: `userAgent` (string), `proxyType` (string), `proxyAddress` (string), `proxyPort` (integer), `proxyLogin` (string), `proxyPassword` (string).
- Fixed wire values: `{"type":"ProsopoTask"}`.

### ComplexImageTask:recaptcha

Family: `recaptcha_recognition`. [Official contract](https://docs.capmonster.cloud/docs/captchas/recaptcha-click/).

- Required: `metadata.Grid` (string).
- Optional: `imageUrls` (array), `imagesBase64` (array), `metadata.TaskDefinition` (string), `metadata.Task` (string), `userAgent` (string), `websiteURL` (string), `metadata` (object).
- Fixed wire values: `{"type":"ComplexImageTask","class":"recaptcha"}`.
- Alternatives: `imageUrls` or `imagesBase64`; `metadata.Task` or `metadata.TaskDefinition`.

### RecaptchaV2EnterpriseTask

Family: `recaptcha_v2_enterprise`. [Official contract](https://docs.capmonster.cloud/docs/captchas/recaptcha-v2-enterprise-task/).

- Required: `websiteURL` (string), `websiteKey` (string).
- Optional: `pageAction` (string), `enterprisePayload` (object), `apiDomain` (string), `userAgent` (string), `cookies` (string), `proxyType` (string), `proxyAddress` (string), `proxyPort` (integer), `proxyLogin` (string), `proxyPassword` (string).
- Fixed wire values: `{"type":"RecaptchaV2EnterpriseTask"}`.

### RecaptchaV3EnterpriseTask

Family: `recaptcha_v3_enterprise`. [Official contract](https://docs.capmonster.cloud/docs/captchas/recaptcha-v3-enterprise-task/).

- Required: `websiteURL` (string), `websiteKey` (string).
- Optional: `minScore` (number), `pageAction` (string).
- Fixed wire values: `{"type":"RecaptchaV3EnterpriseTask"}`.

### RecaptchaV3TaskProxyless

Family: `recaptcha_v3`. [Official contract](https://docs.capmonster.cloud/docs/captchas/recaptcha-v3-task/).

- Required: `websiteURL` (string), `websiteKey` (string).
- Optional: `isEnterprise` (boolean), `minScore` (number), `pageAction` (string).
- Fixed wire values: `{"type":"RecaptchaV3TaskProxyless"}`.

### CustomTask:TenDI

Family: `tencent`. [Official contract](https://docs.capmonster.cloud/docs/captchas/tendi/).

- Required: `websiteURL` (string), `websiteKey` (string).
- Optional: `metadata.captchaUrl` (string), `userAgent` (string), `proxyType` (string), `proxyAddress` (string), `proxyPort` (integer), `proxyLogin` (string), `proxyPassword` (string), `metadata` (object).
- Fixed wire values: `{"type":"CustomTask","class":"TenDI"}`.

### CustomTask:tspd

Family: `tspd`. [Official contract](https://docs.capmonster.cloud/docs/captchas/tspd-task/).

- Required: `websiteURL` (string), `metadata.tspdCookie` (string), `metadata.htmlPageBase64` (string), `proxyType` (string), `proxyAddress` (string), `proxyPort` (integer).
- Optional: `userAgent` (string), `proxyLogin` (string), `proxyPassword` (string), `metadata` (object).
- Fixed wire values: `{"type":"CustomTask","class":"tspd"}`.

### TurnstileTask:token:1

Family: `cloudflare_challenge`. [Official contract](https://docs.capmonster.cloud/docs/captchas/turnstile-challenge-task/).

- Required: `websiteURL` (string), `websiteKey` (string), `pageAction` (string), `userAgent` (string), `data` (string), `pageData` (string).
- Optional: `apiJsUrl` (string), `proxyType` (string), `proxyAddress` (string), `proxyPort` (integer), `proxyLogin` (string), `proxyPassword` (string).
- Fixed wire values: `{"type":"TurnstileTask","cloudflareTaskType":"token"}`.

### TurnstileTask:cf_clearance:2

Family: `cloudflare_challenge`. [Official contract](https://docs.capmonster.cloud/docs/captchas/turnstile-challenge-task/).

- Required: `websiteURL` (string), `websiteKey` (string), `htmlPageBase64` (string), `userAgent` (string), `proxyType` (string), `proxyAddress` (string), `proxyPort` (integer).
- Optional: `proxyLogin` (string), `proxyPassword` (string).
- Fixed wire values: `{"type":"TurnstileTask","cloudflareTaskType":"cf_clearance"}`.

### TurnstileTask

Family: `turnstile`. [Official contract](https://docs.capmonster.cloud/docs/captchas/turnstile-task/).

- Required: `websiteURL` (string), `websiteKey` (string).
- Optional: `userAgent` (string), `pageAction` (string), `data` (string), `proxyType` (string), `proxyAddress` (string), `proxyPort` (integer), `proxyLogin` (string), `proxyPassword` (string).
- Fixed wire values: `{"type":"TurnstileTask"}`.

### TurnstileTask:wait_room

Family: `cloudflare_waiting_room`. [Official contract](https://docs.capmonster.cloud/docs/captchas/turnstile-waitroom-task/).

- Required: `websiteURL` (string), `websiteKey` (string), `htmlPageBase64` (string), `userAgent` (string), `proxyType` (string), `proxyAddress` (string), `proxyPort` (integer).
- Optional: `proxyLogin` (string), `proxyPassword` (string).
- Fixed wire values: `{"type":"TurnstileTask","cloudflareTaskType":"wait_room"}`.

### YidunTask

Family: `yidun`. [Official contract](https://docs.capmonster.cloud/docs/captchas/yidun-task/).

- Required: `websiteURL` (string), `websiteKey` (string).
- Optional: `userAgent` (string), `yidunGetLib` (string), `yidunApiServerSubdomain` (string), `challenge` (string), `hcg` (string), `hct` (integer), `proxyType` (string), `proxyAddress` (string), `proxyPort` (integer), `proxyLogin` (string), `proxyPassword` (string).
- Fixed wire values: `{"type":"YidunTask"}`.

## solvecaptcha (27 variants)

### base64

Family: `image_to_text`. [Official contract](https://solvecaptcha.com/captcha-solver-api).

- Required: `body` (string).
- Optional: `phrase` (integer), `regsense` (integer), `numeric` (integer), `calc` (integer), `min_len` (integer), `max_len` (integer), `language` (integer), `textinstructions` (string), `imginstructions` (string).
- Fixed wire values: `{"method":"base64"}`.

### recaptcha_v2

Family: `recaptcha_v2`. [Official contract](https://solvecaptcha.com/captcha-solver-api).

- Required: `googlekey` (string), `pageurl` (string).
- Optional: `domain` (string), `invisible` (integer), `data-s` (string), `userAgent` (string), `proxy` (string), `proxytype` (string), `cookies` (string).
- Fixed wire values: `{"method":"userrecaptcha"}`.

### recaptcha_v3

Family: `recaptcha_v3`. [Official contract](https://solvecaptcha.com/captcha-solver-api).

- Required: `googlekey` (string), `pageurl` (string).
- Optional: `domain` (string), `action` (string), `min_score` (number), `proxy` (string), `proxytype` (string), `cookies` (string), `userAgent` (string).
- Fixed wire values: `{"method":"userrecaptcha","version":"v3"}`.

### recaptcha_v2_enterprise

Family: `recaptcha_v2_enterprise`. [Official contract](https://solvecaptcha.com/captcha-solver-api).

- Required: `googlekey` (string), `pageurl` (string).
- Optional: `version` (string), `domain` (string), `invisible` (number), `action` (string), `min_score` (number), `data-s` (string), `cookies` (string), `userAgent` (string), `proxy` (string), `proxytype` (string).
- Fixed wire values: `{"method":"userrecaptcha","enterprise":1}`.

### turnstile

Family: `turnstile`. [Official contract](https://solvecaptcha.com/captcha-solver-api).

- Required: `sitekey` (string), `pageurl` (string).
- Optional: `action` (string), `data` (string), `pagedata` (string), `proxy` (string), `proxytype` (string).
- Fixed wire values: `{"method":"turnstile"}`.

### amazon_waf

Family: `aws_waf`. [Official contract](https://solvecaptcha.com/captcha-solver-api).

- Required: `sitekey` (string), `iv` (string), `context` (string), `pageurl` (string).
- Optional: `challenge_script` (string), `captcha_script` (string), `proxy` (string), `proxytype` (string).
- Fixed wire values: `{"method":"amazon_waf"}`.

### tencent

Family: `tencent`. [Official contract](https://solvecaptcha.com/captcha-solver-api).

- Required: `app_id` (string), `pageurl` (string).
- Optional: `captcha_script` (string), `proxy` (string), `proxytype` (string).
- Fixed wire values: `{"method":"tencent"}`.

### cutcaptcha

Family: `cutcaptcha`. [Official contract](https://solvecaptcha.com/captcha-solver-api).

- Required: `misery_key` (string), `api_key` (string), `pageurl` (string).
- Optional: `proxy` (string), `proxytype` (string).
- Fixed wire values: `{"method":"cutcaptcha"}`.

### lemin

Family: `lemin`. [Official contract](https://solvecaptcha.com/captcha-solver-api).

- Required: `captcha_id` (string), `pageurl` (string).
- Optional: `div_id` (string), `api_server` (string), `proxy` (string), `proxytype` (string).
- Fixed wire values: `{"method":"lemin"}`.

### datadome

Family: `datadome`. [Official contract](https://solvecaptcha.com/captcha-solver-api).

- Required: `captcha_url` (string), `pageurl` (string), `userAgent` (string), `proxy` (string), `proxytype` (string).
- Optional: None.
- Fixed wire values: `{"method":"datadome"}`.

### mt_captcha

Family: `mtcaptcha`. [Official contract](https://solvecaptcha.com/captcha-solver-api).

- Required: `sitekey` (string), `pageurl` (string).
- Optional: `proxy` (string), `proxytype` (string).
- Fixed wire values: `{"method":"mt_captcha"}`.

### altcha

Family: `altcha`. [Official contract](https://solvecaptcha.com/captcha-solver-api).

- Required: `pageurl` (string).
- Optional: `challenge_url` (string), `challenge_json` (string), `proxy` (string), `proxytype` (string).
- Fixed wire values: `{"method":"altcha"}`.
- Alternatives: `challenge_url` or `challenge_json`.

### friendly_captcha

Family: `friendly`. [Official contract](https://solvecaptcha.com/captcha-solver-api).

- Required: `sitekey` (string), `pageurl` (string).
- Optional: `version` (string), `module_script` (string), `nomodule_script` (string), `proxy` (string), `proxytype` (string).
- Fixed wire values: `{"method":"friendly_captcha"}`.

### prosopo

Family: `prosopo`. [Official contract](https://solvecaptcha.com/captcha-solver-api).

- Required: `sitekey` (string), `pageurl` (string).
- Optional: `proxy` (string), `proxytype` (string).
- Fixed wire values: `{"method":"prosopo"}`.

### atb_captcha

Family: `atb`. [Official contract](https://solvecaptcha.com/captcha-solver-api).

- Required: `app_id` (string), `api_server` (string), `pageurl` (string).
- Optional: `proxy` (string), `proxytype` (string).
- Fixed wire values: `{"method":"atb_captcha"}`.

### geetest

Family: `geetest`. [Official contract](https://solvecaptcha.com/captcha-solver-api).

- Required: `pageurl` (string).
- Optional: `gt` (string), `challenge` (string), `api_server` (string), `offline` (number), `new_captcha` (number), `proxy` (string), `proxytype` (string), `userAgent` (string).
- Fixed wire values: `{"method":"geetest"}`.

### geetest_v4

Family: `geetest`. [Official contract](https://solvecaptcha.com/captcha-solver-api).

- Required: `captcha_id` (string), `pageurl` (string).
- Optional: `risk_type` (string), `proxy` (string), `proxytype` (string).
- Fixed wire values: `{"method":"geetest_v4"}`.

### funcaptcha

Family: `funcaptcha`. [Official contract](https://solvecaptcha.com/captcha-solver-api).

- Required: `publickey` (string), `pageurl` (string).
- Optional: `surl` (string), `data` (string), `userAgent` (string), `proxy` (string), `proxytype` (string).
- Fixed wire values: `{"method":"funcaptcha"}`.

### grid

Family: `grid`. [Official contract](https://solvecaptcha.com/captcha-solver-api).

- Required: `body` (string).
- Optional: `canvas` (integer), `textinstructions` (string), `imginstructions` (string), `recaptcharows` (integer), `recaptchacols` (integer), `can_no_answer` (integer), `language` (integer).
- Fixed wire values: `{"method":"base64","recaptcha":1}`.

### coordinates

Family: `coordinates`. [Official contract](https://solvecaptcha.com/captcha-solver-api).

- Required: `body` (string).
- Optional: `textinstructions` (string), `imginstructions` (string), `min_clicks` (integer), `max_clicks` (integer), `language` (integer).
- Fixed wire values: `{"method":"base64","coordinatescaptcha":1}`.

### rotatecaptcha

Family: `rotate`. [Official contract](https://solvecaptcha.com/captcha-solver-api).

- Required: `body` (string).
- Optional: `angle` (integer).
- Fixed wire values: `{"method":"rotatecaptcha"}`.

### captchafox

Family: `captchafox`. [Official contract](https://solvecaptcha.com/captcha-solver-api).

- Required: `sitekey` (string), `pageurl` (string), `proxy` (string), `proxytype` (string), `useragent` (string).
- Optional: `api_server` (string).
- Fixed wire values: `{"method":"captchafox"}`.

### temuimage

Family: `temu_recognition`. [Official contract](https://solvecaptcha.com/captcha-solver-api).

- Required: `body` (string), `part1` (string), `part2` (string), `part3` (string).
- Optional: None.
- Fixed wire values: `{"method":"temuimage"}`.

### vkimage

Family: `vk_recognition`. [Official contract](https://solvecaptcha.com/captcha-solver-api).

- Required: `body` (string), `steps` (string).
- Optional: None.
- Fixed wire values: `{"method":"vkimage"}`.

### vkcaptcha

Family: `vk`. [Official contract](https://solvecaptcha.com/captcha-solver-api).

- Required: `redirect_uri` (string), `userAgent` (string), `proxy` (string), `proxytype` (string).
- Optional: None.
- Fixed wire values: `{"method":"vkcaptcha"}`.

### text

Family: `text_captcha`. [Official contract](https://solvecaptcha.com/captcha-solver-api).

- Required: `textcaptcha` (string).
- Optional: `language` (integer), `lang` (string).
- Fixed wire values: `{}`.

### recaptcha_v3:enterprise

Family: `recaptcha_v3_enterprise`. [Official contract](https://solvecaptcha.com/captcha-solver-api).

- Required: `googlekey` (string), `pageurl` (string).
- Optional: `domain` (string), `action` (string), `min_score` (number), `proxy` (string), `proxytype` (string), `cookies` (string), `userAgent` (string).
- Fixed wire values: `{"method":"userrecaptcha","version":"v3","enterprise":1}`.

## anti-captcha (23 variants)

### AltchaTask

Family: `altcha`. [Official contract](https://anti-captcha.com/apidoc/task-types/AltchaTask).

- Required: `websiteURL` (string), `proxyType` (string), `proxyAddress` (string), `proxyPort` (integer).
- Optional: `challengeURL` (string), `challengeJSON` (string), `proxyLogin` (string), `proxyPassword` (string).
- Fixed wire values: `{"type":"AltchaTask"}`.
- Alternatives: `challengeURL` or `challengeJSON`.

### AltchaTaskProxyless

Family: `altcha`. [Official contract](https://anti-captcha.com/apidoc/task-types/AltchaTaskProxyless).

- Required: `websiteURL` (string).
- Optional: `challengeURL` (string), `challengeJSON` (string).
- Fixed wire values: `{"type":"AltchaTaskProxyless"}`.
- Alternatives: `challengeURL` or `challengeJSON`.

### AmazonTask

Family: `aws_waf`. [Official contract](https://anti-captcha.com/apidoc/task-types/AmazonTask).

- Required: `websiteURL` (string), `websiteKey` (string), `iv` (string), `context` (string), `proxyType` (string), `proxyAddress` (string), `proxyPort` (integer).
- Optional: `captchaScript` (string), `challengeScript` (string), `proxyLogin` (string), `proxyPassword` (string).
- Fixed wire values: `{"type":"AmazonTask"}`.

### AmazonTaskProxyless

Family: `aws_waf`. [Official contract](https://anti-captcha.com/apidoc/task-types/AmazonTaskProxyless).

- Required: `websiteURL` (string), `websiteKey` (string), `iv` (string), `context` (string).
- Optional: `captchaScript` (string), `challengeScript` (string).
- Fixed wire values: `{"type":"AmazonTaskProxyless"}`.

### AntiGateTask

Family: `antigate`. [Official contract](https://anti-captcha.com/apidoc/task-types/AntiGateTask).

- Required: `websiteURL` (string), `templateName` (string), `variables` (object), `proxyAddress` (string), `proxyPort` (integer).
- Optional: `domainsOfInterest` (array), `proxyLogin` (string), `proxyPassword` (string).
- Fixed wire values: `{"type":"AntiGateTask"}`.

### FriendlyCaptchaTask

Family: `friendly`. [Official contract](https://anti-captcha.com/apidoc/task-types/FriendlyCaptchaTask).

- Required: `websiteURL` (string), `websiteKey` (string), `proxyType` (string), `proxyAddress` (string), `proxyPort` (integer).
- Optional: `proxyLogin` (string), `proxyPassword` (string).
- Fixed wire values: `{"type":"FriendlyCaptchaTask"}`.

### FriendlyCaptchaTaskProxyless

Family: `friendly`. [Official contract](https://anti-captcha.com/apidoc/task-types/FriendlyCaptchaTaskProxyless).

- Required: `websiteURL` (string), `websiteKey` (string).
- Optional: None.
- Fixed wire values: `{"type":"FriendlyCaptchaTaskProxyless"}`.

### FunCaptchaTask

Family: `funcaptcha`. [Official contract](https://anti-captcha.com/apidoc/task-types/FunCaptchaTask).

- Required: `websiteURL` (string), `websitePublicKey` (string), `proxyType` (string), `proxyAddress` (string), `proxyPort` (integer), `userAgent` (string).
- Optional: `funcaptchaApiJSSubdomain` (string), `data` (string), `proxyLogin` (string), `proxyPassword` (string).
- Fixed wire values: `{"type":"FunCaptchaTask"}`.

### FunCaptchaTaskProxyless

Family: `funcaptcha`. [Official contract](https://anti-captcha.com/apidoc/task-types/FunCaptchaTaskProxyless).

- Required: `websiteURL` (string), `websitePublicKey` (string).
- Optional: `funcaptchaApiJSSubdomain` (string), `data` (string).
- Fixed wire values: `{"type":"FunCaptchaTaskProxyless"}`.

### GeeTestTask

Family: `geetest`. [Official contract](https://anti-captcha.com/apidoc/task-types/GeeTestTask).

- Required: `websiteURL` (string), `proxyType` (string), `proxyAddress` (string), `proxyPort` (integer), `userAgent` (string).
- Optional: `gt` (string), `challenge` (string), `geetestApiServerSubdomain` (string), `version` (integer), `initParameters` (object), `proxyLogin` (string), `proxyPassword` (string).
- Fixed wire values: `{"type":"GeeTestTask"}`.

### GeeTestTaskProxyless

Family: `geetest`. [Official contract](https://anti-captcha.com/apidoc/task-types/GeeTestTaskProxyless).

- Required: `websiteURL` (string).
- Optional: `gt` (string), `challenge` (string), `geetestApiServerSubdomain` (string), `version` (integer), `initParameters` (object).
- Fixed wire values: `{"type":"GeeTestTaskProxyless"}`.

### ImageToCoordinatesTask

Family: `coordinates`. [Official contract](https://anti-captcha.com/apidoc/task-types/ImageToCoordinatesTask).

- Required: `body` (string).
- Optional: `comment` (string), `mode` (string), `websiteURL` (string).
- Fixed wire values: `{"type":"ImageToCoordinatesTask"}`.

### ImageToTextTask

Family: `image_to_text`. [Official contract](https://anti-captcha.com/apidoc/task-types/ImageToTextTask).

- Required: `body` (string).
- Optional: `phrase` (boolean), `case` (boolean), `numeric` (integer), `math` (boolean), `minLength` (integer), `maxLength` (integer), `comment` (string), `websiteURL` (string), `languagePool` (string).
- Fixed wire values: `{"type":"ImageToTextTask"}`.

### ProsopoTask

Family: `prosopo`. [Official contract](https://anti-captcha.com/apidoc/task-types/ProsopoTask).

- Required: `websiteURL` (string), `websiteKey` (string), `proxyType` (string), `proxyAddress` (string), `proxyPort` (integer).
- Optional: `proxyLogin` (string), `proxyPassword` (string).
- Fixed wire values: `{"type":"ProsopoTask"}`.

### ProsopoTaskProxyless

Family: `prosopo`. [Official contract](https://anti-captcha.com/apidoc/task-types/ProsopoTaskProxyless).

- Required: `websiteURL` (string), `websiteKey` (string).
- Optional: None.
- Fixed wire values: `{"type":"ProsopoTaskProxyless"}`.

### RecaptchaV2EnterpriseTask

Family: `recaptcha_v2_enterprise`. [Official contract](https://anti-captcha.com/apidoc/task-types/RecaptchaV2EnterpriseTask).

- Required: `websiteURL` (string), `websiteKey` (string), `proxyType` (string), `proxyAddress` (string), `proxyPort` (integer), `userAgent` (string).
- Optional: `enterprisePayload` (object), `isInvisible` (boolean), `apiDomain` (string), `proxyLogin` (string), `proxyPassword` (string), `cookies` (string).
- Fixed wire values: `{"type":"RecaptchaV2EnterpriseTask"}`.

### RecaptchaV2EnterpriseTaskProxyless

Family: `recaptcha_v2_enterprise`. [Official contract](https://anti-captcha.com/apidoc/task-types/RecaptchaV2EnterpriseTaskProxyless).

- Required: `websiteURL` (string), `websiteKey` (string).
- Optional: `enterprisePayload` (object), `isInvisible` (boolean), `apiDomain` (string).
- Fixed wire values: `{"type":"RecaptchaV2EnterpriseTaskProxyless"}`.

### RecaptchaV2Task

Family: `recaptcha_v2`. [Official contract](https://anti-captcha.com/apidoc/task-types/RecaptchaV2Task).

- Required: `websiteURL` (string), `websiteKey` (string), `proxyType` (string), `proxyAddress` (string), `proxyPort` (integer), `userAgent` (string).
- Optional: `recaptchaDataSValue` (string), `proxyLogin` (string), `proxyPassword` (string), `cookies` (string), `isInvisible` (boolean).
- Fixed wire values: `{"type":"RecaptchaV2Task"}`.

### RecaptchaV2TaskProxyless

Family: `recaptcha_v2`. [Official contract](https://anti-captcha.com/apidoc/task-types/RecaptchaV2TaskProxyless).

- Required: `websiteURL` (string), `websiteKey` (string).
- Optional: `recaptchaDataSValue` (string), `isInvisible` (boolean).
- Fixed wire values: `{"type":"RecaptchaV2TaskProxyless"}`.

### RecaptchaV3TaskProxyless

Family: `recaptcha_v3`. [Official contract](https://anti-captcha.com/apidoc/task-types/RecaptchaV3TaskProxyless).

- Required: `websiteURL` (string), `websiteKey` (string), `minScore` (number).
- Optional: `pageAction` (string), `isEnterprise` (boolean), `apiDomain` (string).
- Fixed wire values: `{"type":"RecaptchaV3TaskProxyless"}`.

### TurnstileTask

Family: `turnstile`. [Official contract](https://anti-captcha.com/apidoc/task-types/TurnstileTask).

- Required: `websiteURL` (string), `websiteKey` (string), `proxyType` (string), `proxyAddress` (string), `proxyPort` (integer).
- Optional: `action` (string), `cData` (string), `chlPageData` (string), `proxyLogin` (string), `proxyPassword` (string).
- Fixed wire values: `{"type":"TurnstileTask"}`.

### TurnstileTaskProxyless

Family: `turnstile`. [Official contract](https://anti-captcha.com/apidoc/task-types/TurnstileTaskProxyless).

- Required: `websiteURL` (string), `websiteKey` (string).
- Optional: `action` (string), `cData` (string), `chlPageData` (string).
- Fixed wire values: `{"type":"TurnstileTaskProxyless"}`.

### RecaptchaV3TaskProxyless:enterprise

Family: `recaptcha_v3_enterprise`. [Official contract](https://anti-captcha.com/apidoc/task-types/RecaptchaV3TaskProxyless).

- Required: `websiteURL` (string), `websiteKey` (string), `minScore` (number).
- Optional: `pageAction` (string), `apiDomain` (string).
- Fixed wire values: `{"type":"RecaptchaV3TaskProxyless","isEnterprise":true}`.

## nopecha (14 variants)

### recognition/awscaptcha

Family: `aws_recognition`. [Official contract](https://nopecha.com/api-reference/).

- Required: `audio_data` (array).
- Optional: None.
- Fixed wire values: `{}`. Route: `/v1/recognition/awscaptcha`.

### recognition/funcaptcha

Family: `funcaptcha_recognition`. [Official contract](https://nopecha.com/api-reference/).

- Required: `task` (string), `image_data` (array).
- Optional: None.
- Fixed wire values: `{}`. Route: `/v1/recognition/funcaptcha`.

### recognition/funcaptcha_match

Family: `funcaptcha_match`. [Official contract](https://nopecha.com/api-reference/).

- Required: `task` (string), `image_data` (array).
- Optional: None.
- Fixed wire values: `{}`. Route: `/v1/recognition/funcaptcha_match`.

### recognition/geetest

Family: `geetest_recognition`. [Official contract](https://nopecha.com/api-reference/).

- Required: `task` (string), `image_data` (array).
- Optional: None.
- Fixed wire values: `{}`. Route: `/v1/recognition/geetest`.

### recognition/hcaptcha

Family: `hcaptcha_recognition`. [Official contract](https://nopecha.com/api-reference/).

- Required: `data` (object), `data.request_type` (string), `data.requester_question.en` (string), `data.tasklist` (array).
- Optional: `data.requester_question` (object).
- Fixed wire values: `{}`. Route: `/v1/recognition/hcaptcha`.

### recognition/lemincaptcha

Family: `lemin_recognition`. [Official contract](https://nopecha.com/api-reference/).

- Required: `task` (string), `image_data` (array).
- Optional: None.
- Fixed wire values: `{}`. Route: `/v1/recognition/lemincaptcha`.

### recognition/recaptcha

Family: `recaptcha_recognition`. [Official contract](https://nopecha.com/api-reference/).

- Required: `task` (string), `grid` (string or null), `image_data` (array).
- Optional: None.
- Fixed wire values: `{}`. Route: `/v1/recognition/recaptcha`.

### recognition/textcaptcha

Family: `image_to_text`. [Official contract](https://nopecha.com/api-reference/).

- Required: `image_data` (array).
- Optional: None.
- Fixed wire values: `{}`. Route: `/v1/recognition/textcaptcha`.

### token/hcaptcha

Family: `hcaptcha`. [Official contract](https://nopecha.com/api-reference/).

- Required: `sitekey` (string), `url` (string).
- Optional: `proxy` (object), `cookie` (array), `useragent` (string), `data` (object).
- Fixed wire values: `{}`. Route: `/v1/token/hcaptcha`.

### token/recaptcha2

Family: `recaptcha_v2`. [Official contract](https://nopecha.com/api-reference/).

- Required: `sitekey` (string), `url` (string).
- Optional: `proxy` (object), `cookie` (array), `useragent` (string), `data` (object).
- Fixed wire values: `{}`. Route: `/v1/token/recaptcha2`.

### token/recaptcha3

Family: `recaptcha_v3`. [Official contract](https://nopecha.com/api-reference/).

- Required: `sitekey` (string), `url` (string).
- Optional: `proxy` (object), `cookie` (array), `useragent` (string), `data` (object).
- Fixed wire values: `{}`. Route: `/v1/token/recaptcha3`.

### token/turnstile

Family: `turnstile`. [Official contract](https://nopecha.com/api-reference/).

- Required: `sitekey` (string), `url` (string), `proxy` (object).
- Optional: `cookie` (array), `useragent` (string), `data` (object).
- Fixed wire values: `{}`. Route: `/v1/token/turnstile`.

### token/recaptcha2:enterprise

Family: `recaptcha_v2_enterprise`. [Official contract](https://nopecha.com/api-reference/).

- Required: `sitekey` (string), `url` (string).
- Optional: `proxy` (object), `cookie` (array), `useragent` (string), `data` (object).
- Fixed wire values: `{"data.enterprise":true}`. Route: `/v1/token/recaptcha2`.

### token/recaptcha3:enterprise

Family: `recaptcha_v3_enterprise`. [Official contract](https://nopecha.com/api-reference/).

- Required: `sitekey` (string), `url` (string).
- Optional: `proxy` (object), `cookie` (array), `useragent` (string), `data` (object).
- Fixed wire values: `{"data.enterprise":true}`. Route: `/v1/token/recaptcha3`.

## nonecap (2 variants)

### hcaptcha

Family: `hcaptcha`. [Official contract](https://nonecap.com/api-reference/).

- Required: `sitekey` (string), `url` (string).
- Optional: `rqdata` (string), `proxy` (object or string).
- Fixed wire values: `{"type":"hcaptcha"}`. Route: `/v1/solves`.

### hcaptcha_enterprise

Family: `hcaptcha`. [Official contract](https://nonecap.com/api-reference/).

- Required: `sitekey` (string), `url` (string).
- Optional: `rqdata` (string), `proxy` (object or string).
- Fixed wire values: `{"type":"hcaptcha_enterprise"}`. Route: `/v1/solves`.
