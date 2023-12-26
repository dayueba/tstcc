CREATE TABLE IF NOT EXISTS `tx_record`
(
    `id`                       bigint(20) unsigned NOT NULL AUTO_INCREMENT COMMENT '主键ID',
    `status`                   varchar(16) NOT NULL COMMENT '事务状态 hanging/successful/failure',
    `component_try_statuses`   json DEFAULT NULL COMMENT '各组件 try 接口请求状态 hanging/successful/failure',
    `created_at`        datetime     NOT NULL COMMENT '创建时间',
    PRIMARY KEY (`id`) USING BTREE COMMENT '主键索引',
    KEY `idx_status` (`status`) COMMENT '事务状态索引'
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT '事务日志记录';

create table wallet
(
    id              int auto_increment
        primary key,
    user_id         varchar(10) not null,
    balance         int         not null,
    trading_balance int         not null
);
