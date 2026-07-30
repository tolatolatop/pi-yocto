CC ?= cc
CFLAGS ?= -O2
LDFLAGS ?=
PREFIX ?= /usr
DESTDIR ?=

all: edgeprobe

edgeprobe: edgeprobe.c
	$(CC) $(CPPFLAGS) $(CFLAGS) -o $@ $< $(LDFLAGS)

install: edgeprobe
	install -d $(DESTDIR)$(PREFIX)/bin
	install -m 0755 edgeprobe $(DESTDIR)$(PREFIX)/bin/edgeprobe

clean:
	rm -f edgeprobe
