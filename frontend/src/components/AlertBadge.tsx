// 红色圆圈感叹号角标：用于「设置有待完善项」的各级入口
export default function AlertBadge({ size = 14 }: { size?: number }) {
  return (
    <span
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        width: size,
        height: size,
        borderRadius: '50%',
        background: '#ff3b30',
        color: '#fff',
        fontSize: size - 4,
        fontWeight: 700,
        lineHeight: 1,
        marginLeft: 6,
        flexShrink: 0,
      }}
    >
      !
    </span>
  )
}
