#include<iostream>
using namespace std;
class Point{public:
   double m_x,m_y;
   Point(double x=0,double y=0):m_x(x),m_y(y){}
   Point operator-(Point b){return Point(m_x-b.m_x,m_y-b.m_y);}
};
istream& operator>>(istream &is,Point &a){return is>>a.m_x>>a.m_y;}

class Rectangle{public:
   Point a,b;
};
istream& operator>>(istream &is,Rectangle &r){return is>>r.a>>r.b;}
ostream& operator<<(ostream &os,Rectangle &r){
   Point d=r.b-r.a;
   return os<<d.m_x<<" "<<d.m_y;
}

int main(){
   int n;cin>>n;
   while(n--){
      Rectangle rec;cin>>rec;
      cout<<rec<<endl;  //@ @guide uml:rec
   }
   return 0;
}
