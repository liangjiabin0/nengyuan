# DataV大屏地理资源缓存

为避免浏览器从局域网地址直接访问外部资源时遭遇403，在2026-10-02将以下公开DataV资源缓存到应用静态目录，原始响应为200 JSON，未修改地图内容。

- china_all_datav_drill.json：https://geo.datav.aliyun.com/areas_v3/china_all_datav_drill.json
- world_land_boundary.json：https://geo.datav.aliyun.com/areas_v3/world_land_boundary.json
- 100000_boundary.json：https://geo.datav.aliyun.com/areas_v2/bound/100000_boundary.json

南海图片改用仓库原有public/screen/nanhai.jpg。其他DataV脚本仍使用原公开CDN，此缓存不表示整个大屏完全离线可用。更新时核对结构与来源，不替换为测试或虚构地图数据。
