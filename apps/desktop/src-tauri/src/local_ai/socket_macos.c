#include <libproc.h>
#include <sys/proc_info.h>
#include <sys/proc.h>
#include <sys/socket.h>
#include <arpa/inet.h>
#include <stdint.h>

/* Own stable FFI shape; SDK layouts remain entirely on this side. */
struct tesina_tcp_row {
    uint32_t local_address;
    uint32_t remote_address;
    uint16_t local_port;
    uint16_t remote_port;
    uint32_t state; /* 1 listener, 2 established */
};

/* Caller keeps this exact owned PID unreaped; unknown is not evidence of exit. */
int tesina_process_exiting(int pid) {
    struct proc_bsdinfo info;
    /* Nonzero arg includes zombies in this flavor's documented kernel lookup. */
    int bytes = proc_pidinfo(pid, PROC_PIDTBSDINFO, 1, &info, sizeof(info));
    if (bytes != sizeof(info)) return -1;
    return (info.pbi_flags & PROC_FLAG_INEXIT) != 0 || info.pbi_status == SZOMB;
}

int tesina_tcp_rows(int pid, struct tesina_tcp_row *out, int capacity) {
    struct proc_fdinfo fds[4096];
    int bytes = proc_pidinfo(pid, PROC_PIDLISTFDS, 0, fds, sizeof(fds));
    if (bytes <= 0 || bytes >= (int)sizeof(fds) || bytes % sizeof(fds[0])) return -1;
    int count = 0;
    for (int i = 0; i < bytes / (int)sizeof(fds[0]); ++i) {
        if (fds[i].proc_fdtype != PROX_FDTYPE_SOCKET) continue;
        struct socket_fdinfo info;
        int n = proc_pidfdinfo(pid, fds[i].proc_fd, PROC_PIDFDSOCKETINFO, &info, sizeof(info));
        if (n != sizeof(info)) continue; /* A closed descriptor cannot prove ownership. */
        if (info.psi.soi_kind != SOCKINFO_TCP || info.psi.soi_family != AF_INET) continue;
        struct tcp_sockinfo *tcp = &info.psi.soi_proto.pri_tcp;
        if (tcp->tcpsi_state != TSI_S_LISTEN && tcp->tcpsi_state != TSI_S_ESTABLISHED) continue;
        if (count >= capacity) return -1;
        out[count++] = (struct tesina_tcp_row){
            ntohl(tcp->tcpsi_ini.insi_laddr.ina_46.i46a_addr4.s_addr),
            ntohl(tcp->tcpsi_ini.insi_faddr.ina_46.i46a_addr4.s_addr),
            ntohs((uint16_t)tcp->tcpsi_ini.insi_lport),
            ntohs((uint16_t)tcp->tcpsi_ini.insi_fport),
            tcp->tcpsi_state == TSI_S_LISTEN ? 1 : 2
        };
    }
    return count;
}
