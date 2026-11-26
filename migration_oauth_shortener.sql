-- 应用标识迁移：PersonalShortener → Shortener
-- 背景：短链项目仓库/目录已改名为 Shortener，OAuth app slug 同步改名；展示名仍是「屑涵短链」。
--
-- 执行顺序（三步必须连续完成，期间该项目无法登录，短链跳转不受影响）：
--   1. 在 auth 库执行本脚本
--   2. 部署本仓库新代码（allowedApps / 品牌 / knownApps 已改为 Shortener）
--   3. 部署短链项目新代码（OAUTH_APP=Shortener，回调 /oauth/callback）
--
-- 说明：
--   * client_id / secret 不变（oauth_clients.app 是主键，client_id 是另一列），
--     短链项目 config 表里的 OAUTH_CLIENT_ID/SECRET 无需改动。
--   * redirect_uris 同时保留旧 /oauth.php 与新 /oauth/callback，切换期两边都能回跳。
--   * sessions 里旧 aud 的会话已失效，直接删除，让用户重新登录一次。
--   * 回滚：把下面 UPDATE 的左右值对调，并回滚两个仓库的部署。

USE `auth`;

START TRANSACTION;

UPDATE `oauth_clients`
   SET `app` = 'Shortener',
       `redirect_uris` = '["https://tio.fyi/oauth.php","https://tio.fyi/oauth/callback"]'
 WHERE `app` = 'PersonalShortener';

UPDATE `oauth_consents`  SET `app` = 'Shortener' WHERE `app` = 'PersonalShortener';
UPDATE `project_access`  SET `app` = 'Shortener' WHERE `app` = 'PersonalShortener';
UPDATE `project_policy`  SET `app` = 'Shortener' WHERE `app` = 'PersonalShortener';
UPDATE `user_bans`       SET `app` = 'Shortener' WHERE `app` = 'PersonalShortener';

DELETE FROM `sessions` WHERE `app` = 'PersonalShortener';

COMMIT;
