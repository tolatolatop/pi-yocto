#include <stdio.h>
#include <string.h>

int main(int argc, char **argv) {
    if (argc == 2 && strcmp(argv[1], "--self-test") == 0) {
        puts("edgeprobe: ok");
        return 0;
    }
    puts("edgeprobe 1.0");
    return argc == 1 ? 0 : 2;
}
